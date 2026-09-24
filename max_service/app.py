"""Сервис MAX (PyMax, userbot) — отдельный процесс (systemd sborka-max), слушает только 127.0.0.1.

Аккаунт номера авторизуется по SMS-коду (через HTTP, без консоли). Сессия — SQLite в
max_service/data/ (в git не попадает). Node-бэкенд зовёт сервис локально по HTTP.

HTTP (заголовок x-internal-token = MESSENGER_INTERNAL_TOKEN):
  GET  /status                 → {state, me, phone}  state: idle | connecting | code_needed | password_needed | open | error
  POST /login {phone}          → запросить SMS-код на номер
  POST /code {code}            → ввести SMS-код
  POST /password {password}    → пароль 2FA, если MAX его попросит
  POST /logout                 → стереть сессию
  POST /send {phone, text}     → {ok, code?, error?}  code: not_ready | not_registered | bad_phone | send_failed
Входящие личные сообщения → POST {BACKEND}/api/internal/messenger/incoming (опт-ин клиента).
"""
import asyncio
import json
import logging
import os
import random
import re
import time
from pathlib import Path

import aiohttp
from aiohttp import web
from dotenv import load_dotenv
from pymax import Client, ExtraConfig, Message, SmsAuthFlow

BASE = Path(__file__).resolve().parent
load_dotenv(BASE.parent / ".env")

PORT = int(os.getenv("MAX_PORT") or 3102)
TOKEN = os.getenv("MESSENGER_INTERNAL_TOKEN") or ""
BACKEND = f"http://127.0.0.1:{os.getenv('PORT') or 3000}"
MIN_GAP = float(os.getenv("MESSENGER_MIN_GAP_SEC") or 20)
DATA = BASE / "data"
ACCOUNT = DATA / "account.json"
SESSION = "session.db"

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("max")
log.setLevel(logging.INFO)


class Waiter:
    """Ожидание ввода (SMS-код / пароль), который придёт HTTP-запросом."""

    def __init__(self, state_name: str):
        self.state_name = state_name
        self.fut: asyncio.Future | None = None

    async def wait(self) -> str:
        S.state = self.state_name
        self.fut = asyncio.get_running_loop().create_future()
        try:
            return await asyncio.wait_for(self.fut, timeout=600)
        finally:
            self.fut = None

    def put(self, value: str) -> bool:
        if self.fut and not self.fut.done():
            self.fut.set_result(value)
            return True
        return False


class CodeProvider:
    async def get_code(self, phone: str) -> str:
        log.info("жду SMS-код для входа в MAX")
        return await S.code.wait()


class PasswordProvider:
    async def get_password(self, hint: str | None = None) -> str:
        log.info("MAX просит пароль 2FA (подсказка: %s)", hint)
        S.hint = hint
        return await S.password.wait()


class State:
    def __init__(self):
        self.client: Client | None = None
        self.task: asyncio.Task | None = None
        self.state = "idle"
        self.error: str | None = None
        self.hint: str | None = None
        self.phone: str | None = None
        self.me_id: int | None = None
        self.me_name: str | None = None
        self.code = Waiter("code_needed")
        self.password = Waiter("password_needed")
        self.send_lock = asyncio.Lock()
        self.last_sent = 0.0
        self.user_phone: dict[int, str] = {}  # id пользователя MAX → номер (кеш из отправок)


S = State()


def digits(p) -> str:
    return re.sub(r"\D", "", str(p or ""))


def load_account() -> str | None:
    try:
        return json.loads(ACCOUNT.read_text()).get("phone")
    except Exception:
        return None


async def forward_incoming(phone: str, text: str) -> None:
    try:
        async with aiohttp.ClientSession() as http:
            await http.post(
                f"{BACKEND}/api/internal/messenger/incoming",
                json={"channel": "max", "phone": phone, "text": text[:500]},
                headers={"x-internal-token": TOKEN},
                timeout=aiohttp.ClientTimeout(total=15),
            )
    except Exception as e:  # noqa: BLE001
        log.warning("max → backend: %s", e)


def build_client(phone: str) -> Client:
    DATA.mkdir(parents=True, exist_ok=True)
    c = Client(
        phone="+" + digits(phone),
        work_dir=str(DATA),
        session_name=SESSION,
        auth_flow=SmsAuthFlow(CodeProvider(), PasswordProvider()),
        extra_config=ExtraConfig(reconnect=True, reconnect_delay=10),
    )

    @c.on_start()
    async def _started(client: Client) -> None:
        S.state = "open"
        S.error = None
        me = client.me
        S.me_id = me.contact.id if me and me.contact else None
        names = getattr(me.contact, "names", None) if me and me.contact else None
        S.me_name = (getattr(names[0], "name", None) if names else None)
        log.info("MAX подключён, id=%s", S.me_id)

    @c.on_message()
    async def _incoming(message: Message, client: Client) -> None:
        try:
            if not message.sender or message.sender == S.me_id or not message.chat_id:
                return
            # только личные диалоги: id личного чата однозначно вычисляется по паре пользователей
            if S.me_id and client.get_chat_id(S.me_id, message.sender) != message.chat_id:
                return
            phone = S.user_phone.get(message.sender)
            if not phone:
                u = await client.get_user(message.sender)
                phone = digits(getattr(u, "phone", None)) if u else ""
            if phone:
                await forward_incoming(phone, message.text or "")
        except Exception as e:  # noqa: BLE001
            log.warning("max incoming: %s", e)

    return c


async def run_client(phone: str) -> None:
    S.phone = digits(phone)
    S.state = "connecting"
    S.client = build_client(phone)
    try:
        await S.client.start()
        S.state = "idle"
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log.error("MAX клиент остановлен: %s", e)
        S.state = "error"
        S.error = str(e)
    finally:
        S.client = None


def start_client(phone: str) -> None:
    S.task = asyncio.create_task(run_client(phone))


async def stop_client() -> None:
    if S.client:
        try:
            await S.client.close()
        except Exception:  # noqa: BLE001
            pass
    if S.task and not S.task.done():
        S.task.cancel()
        try:
            await S.task
        except BaseException:  # noqa: BLE001
            pass
    S.client = None
    S.task = None
    S.me_id = None
    S.state = "idle"


async def send(phone: str, text: str) -> dict:
    async with S.send_lock:
        if S.state != "open" or not S.client or not S.me_id:
            return {"ok": False, "code": "not_ready", "error": "MAX не подключён"}
        d = digits(phone)
        if len(d) < 10:
            return {"ok": False, "code": "bad_phone", "error": "плохой номер"}
        wait = S.last_sent + MIN_GAP - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            try:
                user = await S.client.search_by_phone("+" + d)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "code": "not_registered", "error": f"номер не найден в MAX: {e}"}
            if not user or not getattr(user, "id", None):
                return {"ok": False, "code": "not_registered", "error": "номер не найден в MAX"}
            S.user_phone[user.id] = d
            chat_id = S.client.get_chat_id(S.me_id, user.id)
            await asyncio.sleep(1.5 + random.random() * 2 + min(3.0, len(text) * 0.025))
            msg = await S.client.send_message(chat_id, text)
            return {"ok": True, "id": getattr(msg, "id", None)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "code": "send_failed", "error": str(e)}
        finally:
            S.last_sent = time.monotonic()


# ---------- HTTP ----------
@web.middleware
async def auth_mw(request: web.Request, handler):
    if request.headers.get("x-internal-token") != TOKEN:
        return web.json_response({"ok": False}, status=403)
    return await handler(request)


async def h_status(_r):
    return web.json_response({
        "ok": True, "state": S.state, "error": S.error, "hint": S.hint,
        "phone": S.phone or load_account(),
        "me": {"id": S.me_id, "name": S.me_name} if S.me_id else None,
    })


async def h_login(r):
    b = await r.json()
    phone = digits(b.get("phone"))
    if len(phone) < 10:
        return web.json_response({"ok": False, "error": "укажите номер"}, status=400)
    await stop_client()
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / SESSION).unlink(missing_ok=True)
    ACCOUNT.write_text(json.dumps({"phone": phone}))
    start_client(phone)
    for _ in range(40):  # ждём, пока MAX отправит SMS и клиент перейдёт в ожидание кода
        if S.state in ("code_needed", "password_needed", "open", "error"):
            break
        await asyncio.sleep(0.5)
    return web.json_response({"ok": S.state != "error", "state": S.state, "error": S.error})


async def h_code(r):
    b = await r.json()
    ok = S.code.put(digits(b.get("code")))
    await asyncio.sleep(3)
    return web.json_response({"ok": ok, "state": S.state, "error": S.error})


async def h_password(r):
    b = await r.json()
    ok = S.password.put(str(b.get("password") or ""))
    await asyncio.sleep(3)
    return web.json_response({"ok": ok, "state": S.state, "error": S.error})


async def h_logout(_r):
    await stop_client()
    (DATA / SESSION).unlink(missing_ok=True)
    ACCOUNT.unlink(missing_ok=True)
    S.phone = None
    return web.json_response({"ok": True})


async def h_send(r):
    b = await r.json()
    text = str(b.get("text") or "")[:2000]
    if not text:
        return web.json_response({"ok": False, "error": "нет текста"}, status=400)
    return web.json_response(await send(b.get("phone"), text))


async def on_startup(_app):
    phone = load_account()
    if phone and (DATA / SESSION).exists():
        start_client(phone)
    else:
        log.info("MAX не авторизован — ждём /login")


async def on_cleanup(_app):
    await stop_client()


def main():
    if not TOKEN:
        raise SystemExit("max: нет MESSENGER_INTERNAL_TOKEN в .env")
    app = web.Application(middlewares=[auth_mw])
    app.add_routes([
        web.get("/status", h_status),
        web.post("/login", h_login),
        web.post("/code", h_code),
        web.post("/password", h_password),
        web.post("/logout", h_logout),
        web.post("/send", h_send),
    ])
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    web.run_app(app, host="127.0.0.1", port=PORT, print=lambda *_: log.info("max: сервис на 127.0.0.1:%s", PORT))


if __name__ == "__main__":
    main()
