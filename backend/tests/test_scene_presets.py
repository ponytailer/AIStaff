"""场景预设（L2 层）：出厂值、合并、实时继承、以及「表单提交」这条预设。

## 这个文件的存在理由

`presets.py` 里最容易被误改的一处，是 `BUILTIN_PRESETS` 只登记了哪些 module。
它看起来像「一份清单」，实际上是**定义器类型下拉的数据源**
（`api/scene_presets.py::list_scene_preset_options` 只遍历它）。
少登记一条，对应的场景类型在界面上就**整条路径消失** —— 不报错、不告警，
新建场景时只是少了一个选项。

所以这里钉三条：

1. `generic.tool_submit` 必须在清单里（否则「表单 + 调接口」无路可走）
2. 它的 `preset_json` 要能把定义器铺成「只差选接口」的样子
3. `tool_api` 属于快照键（不是实时键）—— 实时回读会冲掉用户的参数映射
"""

from __future__ import annotations

from sqlmodel import Session, SQLModel, create_engine

from app.scenes.presets import (
    BUILTIN_PRESETS,
    REALTIME_KEYS,
    SNAPSHOT_KEYS,
    builtin_preset,
    effective_ui_config,
    get_preset,
    initial_scene_fields,
    list_presets_safe,
)


def _db() -> Session:
    """一个空库（只有 `create_all` 建出来的表，没有任何预设行）。

    这正是「新租户第一次打开定义器」的状态：库里有表、没有数据，
    读预设全靠 `BUILTIN_PRESETS` 兜底。
    """
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    return Session(engine)


# ============================================================
# 出厂清单
# ============================================================


def test_builtin_presets_include_tool_submit():
    """`generic.tool_submit` 必须在出厂清单里。

    这条锁的是「界面上有没有这个选项」。定义器的类型下拉只列预设
    （见 `list_scene_preset_options`），清单里没有 = 用户永远建不出这类场景。
    在它被登记之前，「客房送物」只能靠脚本落库 —— 普通用户无路可走。
    """
    keys = [row["module_key"] for row in BUILTIN_PRESETS]
    assert "generic.tool_submit" in keys, (
        "generic.tool_submit 没登记进出厂预设：新建场景的类型下拉里不会有"
        "「表单提交」这一项，用户无法创建「收表单 → 调接口」类场景"
    )


def test_tool_submit_preset_scene_type_matches_module():
    """预设的 `scene_type` 必须与 module 的默认类型一致。

    不一致会怎样：下拉里显示「表单提交」，选中后 `sceneType` 变成
    `table_match`（因为 `scene_type` 字段来自这里），于是定义器渲染出
    「数据表」「匹配策略」两个区块，保存后走的是查表通道 —— 表单永远不出。
    """
    preset = builtin_preset("generic.tool_submit")
    assert preset is not None
    assert preset["scene_type"] == "tool_submit"


def test_tool_submit_preset_is_enabled_and_listed():
    """停用的预设不进下拉。所以它必须是 `enabled=True`。"""
    db = _db()
    try:
        rows = list_presets_safe(db, only_enabled=True)
        keys = [row["module_key"] for row in rows]
        assert "generic.tool_submit" in keys
    finally:
        db.close()


# ============================================================
# preset_json 的内容
# ============================================================


def test_tool_submit_preset_prefills_what_user_cannot_edit():
    """用户改不了的那几项，预设必须给全 —— 否则定义器一打开是空的。

    `ui_config.fallback_text` 尤其关键：它是非 UI 渠道（微信 / 纯文本）唯一
    能看到的一句话，也是发布校验的必填项之一。
    """
    payload = builtin_preset("generic.tool_submit")["preset_json"]
    ui_config = payload["ui_config"]

    assert str(ui_config.get("fallback_text") or "").strip(), "fallback_text 不能为空"
    assert str(ui_config.get("form_title") or "").strip(), "form_title 不能为空"
    assert str(payload.get("description") or "").strip(), "description 不能为空"
    assert payload.get("icons"), "icons 不能为空，否则图标下拉没有选项"


def test_tool_submit_preset_tool_name_is_empty():
    """`tool_name` **必须**留空。

    工具是租户自己建的（`room.delivery_submit` 只存在于 demo 租户）。
    出厂值写死任何一个名字，别的租户选中这条预设后都会立刻报「工具不存在」，
    而且用户不知道要去改它 —— 因为下拉里显示的是个看起来正常的名字。

    留空时通道给的是「这个场景还没有配置要调用的接口」这类可行动的原因，
    比调一个不存在的工具、拿到 404 再猜要好。
    """
    tool_api = builtin_preset("generic.tool_submit")["preset_json"]["tool_api"]
    assert tool_api["tool_name"] == ""


def test_tool_submit_preset_tool_api_has_skeleton():
    """骨架里该有的都要有：超时、回复模板句式、两个字典。

    `reply_template` 留空也能跑（后端按返回值的人话字段兜底），但那样
    每个接口的回复口吻都不一样。给一句句式建议，用户改名就能用。
    """
    tool_api = builtin_preset("generic.tool_submit")["preset_json"]["tool_api"]
    assert isinstance(tool_api.get("param_map"), dict)
    assert isinstance(tool_api.get("field_labels"), dict)
    assert float(tool_api.get("timeout_seconds") or 0) > 0
    assert "{{" in str(tool_api.get("reply_template") or ""), (
        "reply_template 里应该有占位符示例，否则用户不知道能取返回值字段"
    )


def test_tool_submit_preset_covers_every_copy_param():
    """回执卡的每一项**话术**都要在预设里有一份。

    ## 为什么逐项钉，而不是「有 params 就行」

    这些键都是「留空 = 吃兜底」，漏了表现为「超管在预设页改不到」，界面上
    没有那个框。

    期望值取自前端 `generic.tool_submit/params.ts` 的
    `GENERIC_TOOL_SUBMIT_DEFAULTS`。两边不一致的后果是「预设页显示的默认值」
    与「卡片实际兜底句」不同 —— 超管看到一串字，用户看到另一串。

    ## `progress_text` / `progress_query` 为什么**不许**再出现在这里

    2026-11-26 删掉了回执卡右下角那颗「查看进度」按钮（点了没用：它只是
    `sendText` 一句话，模型手上没有这张回执的上下文）。前端渲染代码一并删除，
    所以预设里**必须**同步删掉这两项 —— 留着的话超管在预设页仍能看到两个
    输入框，填了完全没效果，正是「同一个东西两处行为不一致」。
    """

    params = builtin_preset("generic.tool_submit")["preset_json"]["ui_config"]["params"]
    expected = {
        "receipt_title": "已提交",
        "receipt_subtitle": "",
        "receipt_no_field": "",
        "receipt_no_label": "",
    }
    for key, want in expected.items():
        assert key in params, f"预设缺 {key}：超管在预设页看不到这一项"
        assert params[key] == want, (
            f"{key} 的预设值与前端 GENERIC_TOOL_SUBMIT_DEFAULTS 不一致："
            f"预设 {params[key]!r} vs 前端 {want!r}"
        )
    for gone in ("progress_text", "progress_query"):
        assert gone not in params, (
            f"预设里还有 {gone}：那颗「查看进度」按钮已经删了，"
            "留着这一项等于给超管一个填了不生效的输入框"
        )


def test_tool_submit_preset_slots_are_text_and_minimal():
    """槽位预填「最小可用的一组」，且类型是 text。

    两个理由：
    - 数量：预填五个不相干字段，做「报修」「预约」的用户要先删三个才能开始。
      预填零个又等于「从零加」，比改 label 费事。
    - 类型：表单提交的字段是房间号、物品名这类文本。给 `number` 会让前端画成
      分段按钮，而「8306」这种房号一旦被数值化就会丢前导零。
    """
    slots = builtin_preset("generic.tool_submit")["preset_json"]["slots"]
    assert 1 <= len(slots) <= 3, "预填过多会让别的业务先删一堆"
    for slot in slots:
        assert slot["type"] == "text", f"槽位 {slot['key']} 应该是文本"
        assert str(slot.get("label") or "").strip(), f"槽位 {slot['key']} 缺 label"
        # `target` 是这个类型不查表的直接体现：没有列可映射
        assert slot["target"] == ""
    # 至少一个必填，否则表单可以空白提交
    assert any(slot["required"] for slot in slots)


# ============================================================
# 生效方式（实时 vs 快照）
# ============================================================


def test_tool_api_is_a_snapshot_key():
    """`tool_api` 必须是快照键，不能是实时键。

    `param_map` 的源是用户自己的槽位 key —— 各租户的槽位名不一样
    （`room_no` / `roomNumber`）。如果实时回读预设，每次渲染都会把用户
    映射好的那份冲掉，表现为「改一次接口、保存后映射全丢了」。
    """
    assert "tool_api" in SNAPSHOT_KEYS
    assert "tool_api" not in REALTIME_KEYS


def test_ui_config_is_still_realtime():
    """`ui_config` 仍须是实时键（这是预设存在的意义）。

    超管把「已提交」改成「已派单」，全租户存量场景下一句话就变 ——
    这条不能被 `tool_api` 的加入带歪。
    """
    assert "ui_config" in REALTIME_KEYS
    assert "trigger" in REALTIME_KEYS


# ============================================================
# initial_scene_fields
# ============================================================


def test_initial_scene_fields_carry_tool_api():
    """定义器拉默认值时必须拿到 `tool_api` 骨架。

    拿不到的话，「新建表单场景」的用户要自己从零想清楚 reply_template 怎么写、
    timeout 填多少 —— 而这正是预设该替他做掉的事。
    """
    db = _db()
    try:
        fields = initial_scene_fields(db, "generic.tool_submit")
    finally:
        db.close()

    assert fields["scene_type"] == "tool_submit"
    assert fields["icons"], "图标下拉不能是空的"
    assert isinstance(fields["tool_api"], dict)
    assert "reply_template" in fields["tool_api"]
    assert "timeout_seconds" in fields["tool_api"]


def test_initial_scene_fields_ask_prompt_path_matches_scene():
    """引导语走 `respond_action.ask_prompt`，与场景上存的路径一致。

    路径不一致的后果：预填读得到、保存写丢了。定义器拿到 `defaults` 之后
    直接 set 到 state，保存时又拼进 `respond_action` —— 中间少一层映射
    就少一处漂移，所以两边必须是同一条路径。
    """
    db = _db()
    try:
        fields = initial_scene_fields(db, "generic.tool_submit")
    finally:
        db.close()

    respond = fields.get("respond_action") or {}
    assert str(respond.get("ask_prompt") or "").strip()


def test_initial_scene_fields_unknown_module_is_empty_not_crash():
    """未知 module 返回空骨架，不能抛。

    定义器对「停用/删除的预设」会补一个只读占位项，点开时仍会拉默认值。
    这时候抛异常会把整个编辑器打成白屏。
    """
    db = _db()
    try:
        fields = initial_scene_fields(db, "nope.not_exist")
    finally:
        db.close()

    assert fields["module_key"] == "nope.not_exist"
    assert fields["tool_api"] == {}
    assert fields["slots"] == []


# ============================================================
# 覆盖与回滚
# ============================================================


def test_preset_row_overrides_builtin():
    """库里有行时用它，没有时用出厂值 —— 这是「超管改完立即生效」的机制。"""
    from app.scenes.presets import upsert_preset

    db = _db()
    try:
        upsert_preset(
            db,
            module_key="generic.tool_submit",
            display_name="我的提交",
            preset_json={"ui_config": {"fallback_text": "改过的兜底"}},
        )
        row = get_preset(db, "generic.tool_submit")
        assert row["display_name"] == "我的提交"
        assert row["preset_json"]["ui_config"]["fallback_text"] == "改过的兜底"
    finally:
        db.close()


def test_effective_ui_config_merges_scene_over_preset():
    """场景自己配了某键就用它，没配的吃预设。"""

    class _Scene:
        module_key = "generic.tool_submit"
        ui_config_json = {"fallback_text": "场景自己的兜底"}

    db = _db()
    try:
        merged = effective_ui_config(_Scene(), db)
    finally:
        db.close()

    # 场景显式配的盖掉预设
    assert merged["fallback_text"] == "场景自己的兜底"
    # 场景没配的仍来自预设
    assert str(merged.get("form_title") or "").strip()