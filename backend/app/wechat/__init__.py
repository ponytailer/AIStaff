"""个人微信渠道（腾讯 iLink 协议）。

模块边界刻意做成「微信专用、不依赖多渠道抽象」：

- ``client``    iLink HTTP 协议层（扫码 / getupdates / sendmessage / typing）
- ``crypto``    bot_token 的对称加解密
- ``routing``   /员工、/切换 等指令与「当前员工」指针
- ``identity``  微信用户懒建、扫码自动绑定与 /解绑
- ``service``   单条入站消息的完整处理链路
- ``poller``    每个绑定的长轮询线程（退避 / 熔断 / 自愈）
"""

from __future__ import annotations

__all__ = ["client", "crypto", "identity", "poller", "routing", "service"]