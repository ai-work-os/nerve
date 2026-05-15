#!/usr/bin/env python3
"""
email-watcher — IMAP IDLE 守护进程，新邮件 → AI 判断 → 自动复制验证码到剪贴板。

零外部依赖（python stdlib 全包）。每个账号一个线程，IDLE 长连接 + 自动重连。

用法：
  python3 email-watcher.py daemon                 # 长跑（launchd 用）
  python3 email-watcher.py test <path-to-eml>     # 用一个本地 .eml 单次烟测
  python3 email-watcher.py once <account>         # 拉取一次最新邮件并处理（debug）

凭证: ~/.config/email-watcher/accounts.json (chmod 600)
日志: ~/.ai/ops/logs/email-watcher/{date}.log
"""

import email
import email.header
import email.policy
import imaplib
import json
import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HOME = Path.home()
ACCOUNTS_PATH = HOME / ".config/email-watcher/accounts.json"
LOG_DIR = HOME / ".ai/ops/logs/email-watcher"
DEEPSEEK_AUTH_PATH = HOME / ".local/share/opencode/auth.json"

LOG_DIR.mkdir(parents=True, exist_ok=True)


# --- 日志 ---

def setup_logging():
    log_file = LOG_DIR / f"{datetime.now():%Y-%m-%d}.log"
    handler = logging.FileHandler(log_file, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] [%(threadName)s] %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(handler)
    # 也写到 stderr 方便交互调试
    sh = logging.StreamHandler(sys.stderr)
    sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] [%(threadName)s] %(message)s"))
    root.addHandler(sh)


# --- 凭证 ---

def load_accounts():
    if not ACCOUNTS_PATH.exists():
        raise SystemExit(f"凭证文件不存在: {ACCOUNTS_PATH}")
    with open(ACCOUNTS_PATH) as f:
        data = json.load(f)
    return [a for a in data["accounts"] if "FILL_" not in a.get("username", "")]


def load_deepseek_key():
    if not DEEPSEEK_AUTH_PATH.exists():
        raise SystemExit(f"deepseek 凭证不存在: {DEEPSEEK_AUTH_PATH}")
    with open(DEEPSEEK_AUTH_PATH) as f:
        return json.load(f)["deepseek"]["key"]


# --- 邮件解析 ---

def decode_header_str(value):
    if value is None:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, charset in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(charset or "utf-8", errors="replace"))
            except LookupError:
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def extract_body(msg):
    """Prefer text/plain. Fall back to text/html (strip tags)."""
    plain_parts = []
    html_parts = []
    for part in msg.walk():
        ctype = part.get_content_type()
        if part.get("Content-Disposition", "").startswith("attachment"):
            continue
        try:
            payload = part.get_payload(decode=True)
            if not payload:
                continue
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
        except Exception:
            continue
        if ctype == "text/plain":
            plain_parts.append(text)
        elif ctype == "text/html":
            html_parts.append(text)
    if plain_parts:
        return "\n".join(plain_parts).strip()
    if html_parts:
        html = "\n".join(html_parts)
        # 粗暴脱 html
        no_tags = re.sub(r"<[^>]+>", " ", html)
        no_entities = re.sub(r"&[a-zA-Z#0-9]+;", " ", no_tags)
        return re.sub(r"\s+", " ", no_entities).strip()
    return ""


def parse_eml(raw_bytes):
    msg = email.message_from_bytes(raw_bytes, policy=email.policy.default)
    return {
        "subject": decode_header_str(msg.get("Subject", "")).strip(),
        "from": decode_header_str(msg.get("From", "")).strip(),
        "date": decode_header_str(msg.get("Date", "")).strip(),
        "body": extract_body(msg),
    }


# --- AI 判断（deepseek API，OpenAI 兼容）---

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"

SYSTEM_PROMPT = """你是邮件验证码识别器。给你一封邮件（subject + from + body），判断：
1. 这封邮件是否含"一次性验证码 / 注册码 / 登录码 / OTP / verification code / security code"
2. 如果是，提取出验证码字串

只输出 JSON，不要其他任何文字：
- 是验证码: {"is_code": true, "code": "123456", "source": "网站/服务名（如知道）"}
- 不是: {"is_code": false}

注意：
- 验证码通常是 4-8 位数字或字母数字组合
- "验证您的邮箱"这类注册激活邮件里包含的码也算
- 单纯的通知/广告/账单邮件不算
- 已过期的旧验证码不算
"""


def deepseek_judge(api_key, mail, model="deepseek-chat"):
    user_content = f"Subject: {mail['subject']}\nFrom: {mail['from']}\nBody (前 2000 字符):\n{mail['body'][:2000]}"
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        DEEPSEEK_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        logging.error(f"deepseek HTTP {e.code}: {e.read()[:200].decode('utf-8', errors='replace')}")
        return {"is_code": False, "error": f"http_{e.code}"}
    except Exception as e:
        logging.error(f"deepseek 调用失败: {e}")
        return {"is_code": False, "error": str(e)}
    content = data["choices"][0]["message"]["content"]
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        logging.warning(f"deepseek 返回非 JSON: {content[:200]}")
        return {"is_code": False, "error": "non_json", "raw": content[:200]}


# --- 落地 ---

def pbcopy(text):
    subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)


def macos_notify(title, message):
    """osascript 系统通知。message/title 转义双引号 + 反斜杠。"""
    def esc(s):
        return s.replace("\\", "\\\\").replace('"', '\\"')
    script = f'display notification "{esc(message)}" with title "{esc(title)}"'
    try:
        subprocess.run(["osascript", "-e", script], check=True, timeout=5)
    except Exception as e:
        logging.warning(f"通知失败: {e}")


# --- 邮件处理主流程 ---

def handle_mail(api_key, mail, account_name):
    logging.info(f"[{account_name}] subject={mail['subject'][:60]!r} from={mail['from'][:60]!r}")
    judgment = deepseek_judge(api_key, mail)
    if judgment.get("is_code"):
        code = str(judgment["code"]).strip()
        source = judgment.get("source", "未知来源")
        pbcopy(code)
        macos_notify(f"✉️ 验证码 {code}", f"{source} · 已复制到剪贴板")
        logging.info(f"[{account_name}] ✅ 验证码 {code} ({source}) 已 pbcopy")
        return True
    else:
        err = judgment.get("error")
        if err:
            logging.warning(f"[{account_name}] AI 判断异常: {err}")
        else:
            logging.info(f"[{account_name}] 非验证码邮件，跳过")
        return False


# --- IMAP IDLE 监听（每账号一个 worker 线程）---

def compute_baseline(prev_last_uid, mailbox_uids):
    """决定本次连接的 last_uid baseline。

    首次连接 (prev_last_uid is None)：baseline 到邮箱当前最新 UID，
        启动前的历史邮件不处理。
    重连 (prev_last_uid 已有值)：保留旧值，不重新 baseline ——
        否则断连窗口期到达的邮件 UID 会落在新 baseline 之下被永久跳过。
        保留旧值后，重连的增量搜索 (UID prev+1:*) 会把它们补回。

    mailbox_uids: IMAP UID SEARCH ALL 的结果（bytes 列表，升序）。
    """
    if prev_last_uid is None:
        return int(mailbox_uids[-1]) if mailbox_uids else 0
    return prev_last_uid


class AccountWorker(threading.Thread):
    def __init__(self, account, api_key):
        super().__init__(daemon=True, name=account["name"])
        self.account = account
        self.api_key = api_key
        self.stop_flag = threading.Event()
        self._connected_once = False  # 仅用于日志区分首次连接 / 重连
        self.last_uid = None          # 跨重连保留，None=尚未 baseline

    def run(self):
        backoff = 1
        while not self.stop_flag.is_set():
            try:
                self._loop()
                backoff = 1
            except Exception as e:
                logging.error(f"循环异常: {e}; {backoff}s 后重连")
                time.sleep(backoff)
                backoff = min(backoff * 2, 300)

    def _loop(self):
        a = self.account
        logging.info(f"连接 {a['imap_host']}:{a['imap_port']} as {a['username']}")
        with imaplib.IMAP4_SSL(a["imap_host"], a["imap_port"]) as imap:
            imap.login(a["username"], a["password"])
            imap.select("INBOX")
            # 首次连接 baseline 到当前最新；重连保留旧 last_uid（见 compute_baseline）
            typ, data = imap.uid("search", None, "ALL")
            uids = data[0].split() if data and data[0] else []
            self.last_uid = compute_baseline(self.last_uid, uids)
            kind = "重连" if self._connected_once else "首次连接"
            self._connected_once = True
            logging.info(f"{kind} baseline last_uid={self.last_uid}（此 UID 之前的邮件不再处理）")

            # (重)连后立刻补搜一次：捞回断连窗口期到达的邮件（首次连接此搜索必为空）
            self._fetch_and_handle(imap)

            while not self.stop_flag.is_set():
                try:
                    self._idle_wait(imap)
                except Exception as e:
                    logging.warning(f"IDLE 异常: {e}，结束本次连接，准备重连")
                    return
                # IDLE 醒来 → 查新邮件
                self._fetch_and_handle(imap)

    def _fetch_and_handle(self, imap):
        """搜索 last_uid 之后的新邮件并逐封处理，推进 self.last_uid。"""
        typ, data = imap.uid("search", None, f"UID {self.last_uid + 1}:*")
        new_uids = ([u for u in data[0].split() if int(u) > self.last_uid]
                    if data and data[0] else [])
        if not new_uids:
            logging.info(f"增量搜索（UID>{self.last_uid}）：无新邮件")
            return
        logging.info(f"增量搜索（UID>{self.last_uid}）：发现 {len(new_uids)} 封新邮件 "
                     f"uids={[u.decode() for u in new_uids]}")
        for uid in new_uids:
            typ, fetch = imap.uid("fetch", uid, "(RFC822)")
            if typ != "OK" or not fetch or not fetch[0]:
                logging.warning(f"fetch 失败 uid={uid.decode()} typ={typ}")
                continue
            raw = fetch[0][1]
            try:
                mail = parse_eml(raw)
            except Exception as e:
                logging.error(f"解析失败 uid={uid}: {e}")
                continue
            handle_mail(self.api_key, mail, self.account["name"])
            self.last_uid = max(self.last_uid, int(uid))

    def _idle_wait(self, imap):
        """imaplib 没原生 IDLE。手动写命令 + 等服务端推送。"""
        tag = imap._new_tag()
        imap.send(f"{tag.decode() if isinstance(tag, bytes) else tag} IDLE\r\n".encode("utf-8"))
        # 等 "+ idling" 响应
        resp = imap.readline()
        if not resp.startswith(b"+"):
            raise RuntimeError(f"IDLE 拒绝: {resp!r}")
        logging.info("进入 IDLE，等待服务端推送（最多 25min）")
        # 长 sock 等推送，最多 25 分钟（RFC 推荐 < 29min）
        imap.sock.settimeout(25 * 60)
        wake = "未知（stop_flag 触发）"
        try:
            while not self.stop_flag.is_set():
                line = imap.readline()
                if not line:
                    wake = "连接关闭（服务端断开）"
                    break
                if line.startswith(b"* "):
                    # 推送：EXISTS / EXPUNGE / FETCH
                    if b"EXISTS" in line or b"RECENT" in line:
                        wake = "新邮件推送"
                        break
                # 服务端 keep-alive，继续等
        except socket.timeout:
            wake = "25min 超时（正常轮转）"  # 自然到 25 min，重连
        finally:
            logging.info(f"IDLE 醒来：{wake}")
            imap.send(b"DONE\r\n")
            # 等 tag OK
            imap.sock.settimeout(30)
            while True:
                line = imap.readline()
                if not line:
                    break
                tag_str = tag.decode() if isinstance(tag, bytes) else tag
                if line.startswith(tag_str.encode()):
                    break


# --- 入口 ---

def cmd_daemon():
    setup_logging()
    accounts = load_accounts()
    if not accounts:
        logging.error("无可用账号（all FILL_ placeholders）。退出。")
        sys.exit(1)
    api_key = load_deepseek_key()
    logging.info(f"daemon 启动，{len(accounts)} 个账号")
    workers = [AccountWorker(a, api_key) for a in accounts]
    for w in workers:
        w.start()
    try:
        tick = 0
        while True:
            time.sleep(60)
            tick += 1
            alive = [w.name for w in workers if w.is_alive()]
            if len(alive) < len(workers):
                logging.warning(f"alive={alive}, expected={len(workers)}")
            elif tick % 10 == 0:
                # 每 10min 一次心跳，证明 daemon 还活着（区分健康空跑 vs 卡死）
                logging.info(f"心跳：{len(alive)} 个账号 worker 存活 {alive}")
    except KeyboardInterrupt:
        logging.info("收到 SIGINT，停止")
        for w in workers:
            w.stop_flag.set()


def cmd_test(eml_path):
    setup_logging()
    api_key = load_deepseek_key()
    raw = Path(eml_path).read_bytes()
    mail = parse_eml(raw)
    print(f"--- 解析 ---\nSubject: {mail['subject']}\nFrom: {mail['from']}\nBody (前 300):\n{mail['body'][:300]}\n")
    print("--- AI 判断 ---")
    is_code = handle_mail(api_key, mail, "test")
    print(f"is_code={is_code}")


def cmd_once(account_name):
    """拉一次最新邮件并处理 — debug 用，不开 IDLE。"""
    setup_logging()
    accounts = load_accounts()
    api_key = load_deepseek_key()
    a = next((x for x in accounts if x["name"] == account_name), None)
    if not a:
        raise SystemExit(f"账号 {account_name} 不在 accounts.json 或 username 还是 placeholder")
    with imaplib.IMAP4_SSL(a["imap_host"], a["imap_port"]) as imap:
        imap.login(a["username"], a["password"])
        imap.select("INBOX")
        typ, data = imap.uid("search", None, "ALL")
        uids = data[0].split() if data and data[0] else []
        if not uids:
            print("INBOX 空")
            return
        latest = uids[-1]
        typ, fetch = imap.uid("fetch", latest, "(RFC822)")
        mail = parse_eml(fetch[0][1])
        print(f"--- 最新邮件 ({account_name}) uid={latest.decode()} ---")
        print(f"Subject: {mail['subject']}\nFrom: {mail['from']}\n")
        handle_mail(api_key, mail, account_name)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "daemon":
        cmd_daemon()
    elif cmd == "test" and len(sys.argv) >= 3:
        cmd_test(sys.argv[2])
    elif cmd == "once" and len(sys.argv) >= 3:
        cmd_once(sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
