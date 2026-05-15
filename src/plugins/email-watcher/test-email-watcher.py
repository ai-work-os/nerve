#!/usr/bin/env python3
"""email-watcher 单元测试 —— 纯函数 + 假 IMAP，无网络、无真实 IMAP。

跑：python3 test-email-watcher.py

覆盖重点：重连时 last_uid 的 baseline 行为（曾经的 bug：重连重新 baseline
到最新，把断连窗口期到达的邮件永久跳过）。
"""
import importlib.util
import sys
from pathlib import Path

# email-watcher.py 带连字符，不能直接 import，用 importlib 按路径加载。
_spec = importlib.util.spec_from_file_location(
    "email_watcher", Path(__file__).parent / "email-watcher.py")
ew = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ew)

_passed = 0
_failed = 0


def check(name, got, want):
    global _passed, _failed
    if got == want:
        _passed += 1
        print(f"  ok  {name}")
    else:
        _failed += 1
        print(f"  FAIL {name}: got={got!r} want={want!r}")


# --- compute_baseline ---
print("=== compute_baseline ===")
# 首次连接（prev=None）：baseline 到邮箱当前最新 UID，启动前的历史邮件不处理。
check("首次连接-非空邮箱", ew.compute_baseline(None, [b"101", b"102", b"105"]), 105)
check("首次连接-空邮箱", ew.compute_baseline(None, []), 0)
# 重连（prev 已有值）：必须保留旧 last_uid。
# —— 这正是被修的 bug：旧代码重连会返回 108，把 106/107/108 三封永久跳过。
check("重连-保留旧值(核心 bug)", ew.compute_baseline(105, [b"106", b"107", b"108"]), 105)
check("重连-旧值为 0 也保留", ew.compute_baseline(0, [b"1", b"2"]), 0)
check("重连-邮箱无变化", ew.compute_baseline(105, [b"105"]), 105)


# --- _fetch_and_handle：重连补搜真的捞回断连窗口的邮件 ---
print("=== _fetch_and_handle 重连补搜 ===")


class FakeIMAP:
    """只实现 _fetch_and_handle 用到的 uid()。"""

    def __init__(self, present_uids):
        self.present = sorted(int(u) for u in present_uids)

    def uid(self, cmd, *args):
        if cmd == "search":
            lo = int(args[1].split()[1].split(":")[0])  # "UID 106:*"
            hits = [u for u in self.present if u >= lo]
            return ("OK", [b" ".join(str(u).encode() for u in hits)])
        if cmd == "fetch":
            uid = args[0]
            return ("OK", [(b"meta", b"raw-" + uid)])
        raise AssertionError(f"unexpected uid cmd: {cmd}")


def make_worker(last_uid):
    """绕过 __init__ 的线程逻辑，只装 _fetch_and_handle 需要的属性。"""
    w = ew.AccountWorker.__new__(ew.AccountWorker)
    w.account = {"name": "t"}
    w.api_key = "x"
    w.last_uid = last_uid
    return w


_handled = []
_orig_parse, _orig_handle = ew.parse_eml, ew.handle_mail
ew.parse_eml = lambda raw: {"raw": raw}
ew.handle_mail = lambda key, mail, name: _handled.append(mail["raw"])
try:
    # 重连场景：last_uid 保留为 105，邮箱断连期间多了 106..110，
    # 必须全部被补搜处理掉，last_uid 推进到 110。
    w = make_worker(105)
    w._fetch_and_handle(FakeIMAP([105, 106, 107, 108, 109, 110]))
    check("重连补搜处理了断连窗口的邮件", sorted(_handled),
          [b"raw-106", b"raw-107", b"raw-108", b"raw-109", b"raw-110"])
    check("last_uid 推进到最新", w.last_uid, 110)

    # 无新邮件：last_uid 不动，不处理任何邮件。
    _handled.clear()
    w2 = make_worker(110)
    w2._fetch_and_handle(FakeIMAP([110]))
    check("无新邮件-不处理", _handled, [])
    check("无新邮件-last_uid 不变", w2.last_uid, 110)
finally:
    ew.parse_eml, ew.handle_mail = _orig_parse, _orig_handle


print(f"\n{_passed} passed, {_failed} failed")
sys.exit(1 if _failed else 0)
