"""场景元数据包（v3 插件模型的运行时层）。

与 ``app/scenes/`` 的分工：

- ``app/scenes/`` —— **匹配库**：``normalize`` / ``matcher`` / ``schema`` /
  ``table_parser``。纯计算，不知道 DB、不知道 HTTP、不知道会话。
- ``app/scene_modules/`` —— **运行时**：读 DB、按 ``scene_type`` 分派通道、
  产出 ``SceneUiBlock``、为聊天层提供短路计划与入口胶囊。

为什么不放一起、也不改名 ``app/scenes``：``scenes`` 是 v1 的名字，已经被
``matcher`` / ``normalize`` / ``table_parser`` 三个纯计算模块和 4 份文档引用，
改名会牵连 145 条 R1 用例的 import 路径。新增独立包是零风险的做法。

命名冲突清单（arch §1 的结论，避免自己踩）：

- ``app.scenes.schema``（pydantic 请求/响应模型）≠ ``app.scene_modules.types``
  （运行时 dataclass）
- ``app.scenes.matcher.run_match``（纯匹配）≠ ``channels._run_table_match``
  （取数 + 调 matcher + 产 block）
"""

from __future__ import annotations

from app.scene_modules.types import (
    BlockKind,
    NeedsTable,
    SceneRunResult,
    SceneType,
    SceneUiBlock,
)

__all__ = [
    "BlockKind",
    "NeedsTable",
    "SceneRunResult",
    "SceneType",
    "SceneUiBlock",
]