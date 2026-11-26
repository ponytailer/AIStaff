"""一次性清理：把存量场景里显式写死的 ``show_source_table`` 去掉。

## 为什么需要这个脚本

「副标题里显示来源表名」这个开关的默认值在 2026-11-26 从 ``True`` 改成了
``False``（用户要求：单表场景里的「来自「滑雪套餐价目表 副本」」是内部文件名，
对用户判断方案没帮助）。

但**改默认值对存量场景无效**。原因在 ``app/scenes/presets.py`` 的
``effective_ui_config()``：

    优先级：场景自己显式配了的键 → 预设里的对应键 → 空

它是**按键合并**而不是整份覆盖（这个设计是对的 —— 见那个函数的 docstring：
整份用预设会让老场景的 ``fallback_text`` 变空，而它是发布阻断项）。

于是问题变成：老场景的 ``ui_config_json.params`` 里**存着一份显式的**
``"show_source_table": true``。合并时它优先于预设的新默认值，所以
「改了预设、老场景没变」。

而用户在场景定义器里**也改不了这个值**（``SceneEditor`` 没有这个字段，
它归 L2 预设层管）。两侧都够不着 —— 这就是「改了没生效」的典型形态。

## 判定：只删「等于旧默认值 True」的

不无差别删除。理由：如果某个场景的 ``show_source_table`` 已经是 ``false``，
那是它本来就想要的（或者上一轮已清理过），删掉会让它回落到预设值 ——
虽然现在也是 ``false``，但**语义不同**：「显式关」和「跟随预设」是两件事，
将来预设改回 ``true`` 时两者行为会分叉。

所以本脚本只处理 ``value is True``（严格布尔真，不含 ``"true"`` 字符串 ——
那种是脏数据，留着让 ``_deepcopy_dict`` 之后的重建逻辑处理，不在这里猜）。

## 用法

    cd backend
    .venv/bin/python scripts/fix_show_source_table.py            # 预览（dry-run）
    .venv/bin/python scripts/fix_show_source_table.py --apply    # 实际写入

脚本是**幂等**的：跑第二次会显示「没有需要处理的场景」。
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlmodel import Session, select  # noqa: E402

from app.db.database import engine  # noqa: E402
from app.db.models import Scene  # noqa: E402

#: 要清理的键。加新键时同步下面的提示文案。
TARGET_KEY = "show_source_table"


def scan(session: Session) -> list[tuple[Scene, dict]]:
    """找出「显式存着 True」的场景，返回 ``[(scene, params)]``。"""
    hits: list[tuple[Scene, dict]] = []
    for scene in session.exec(select(Scene)).all():
        ui = scene.ui_config_json or {}
        params = ui.get("params") if isinstance(ui, dict) else None
        if not isinstance(params, dict):
            continue
        if params.get(TARGET_KEY) is True:
            hits.append((scene, params))
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="实际写入数据库。不加这个参数只做预览。",
    )
    args = parser.parse_args()

    with Session(engine) as session:
        targets = scan(session)
        if not targets:
            print(f"没有需要处理的场景（没有场景显式开着 {TARGET_KEY}）。")
            return 0

        print(f"找到 {len(targets)} 个场景显式开着 {TARGET_KEY}：")
        for scene, _params in targets:
            print(f"  - {scene.id}  {scene.name}  (module={scene.module_key})")
        print()

        if not args.apply:
            print("预览模式，未写入。加 --apply 实际执行。")
            print(
                "执行后这些场景会跟随预设的新默认值（不显示来源表名）；"
                "多表场景若仍需显示，请在场景的 ui_config 里重新设 true。"
            )
            return 0

        for scene, params in targets:
            # 必须重建整个 dict 再赋回去：SQLModel 的 JSON 列不会因为
            # 原地 `params.pop()` 就被标记为 dirty（对象同一性没变），
            # 那样会「打印说改了，库里没变」。
            next_params = {k: v for k, v in params.items() if k != TARGET_KEY}
            next_ui = dict(scene.ui_config_json or {})
            next_ui["params"] = next_params
            scene.ui_config_json = next_ui
            session.add(scene)

        session.commit()
        print(f"已处理 {len(targets)} 个场景。")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())