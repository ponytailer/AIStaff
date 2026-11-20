"""澄清反问不该配图 + 单字符查询不该召回全库（2026-11-20）。

用户报：在微信里发了个「1」，员工回了一段完全合理的澄清提问（"我不太确定你
指的是哪方面，方便说明吗？例如 Talents / VPN / Outlook / 会议室"），紧接着
却甩了一整篇 Outlook 文档的截图。

两个独立缺陷叠在一起：
1. 检索侧：``"1" in 正文`` 恒为真，白送 5 分越过 2.0 的证据阈值 → 全库进证据包，
   连带图例也全量带出。
2. 补图侧：兜底补图只挡了「明确说没找到」（``_is_refusal``），没有挡「反问澄清」
   —— 澄清轮根本没有可以对应的正文，配图纯是噪声。
"""

from __future__ import annotations

import pytest

from app.core.engine import turn_knowledge as tk
from app.knowledge.service import _has_identifying_query, _score_single_query, _score_text

# ---- 补图侧：澄清反问不配图 ---------------------------------------------


CLARIFY_REPLY = (
    "你好，我是 Jerry Hu 胡鹏飞，负责 Talents、VPN、Outlook、会议室预定等 IT 相关问题。\n"
    "你发来的“1”我不太确定具体指什么，方便说明一下你想咨询哪方面吗？例如：\n"
    "- Talents 登录或使用问题\n"
    "- VPN（零信任 Astrust）登录\n"
    "- Outlook 邮箱配置\n"
    "\n告诉我具体问题，我来帮你处理。"
)


def test_clarification_reply_is_detected() -> None:
    assert tk._is_clarification(CLARIFY_REPLY) is True


def test_clarification_blocks_appendix() -> None:
    """用户报的那一轮：澄清提问后面不该跟任何配图。"""
    assert tk._append_images_allowed(CLARIFY_REPLY) is False


@pytest.mark.parametrize(
    "reply",
    [
        "请问您想办理哪类业务？",
        "方便说明一下具体是哪台设备吗？",
        "我不太确定你指的是哪个系统，可以说下吗",
        "请补充一下报错截图或提示文字，例如截图里的错误码",
    ],
)
def test_various_clarifications_block_appendix(reply: str) -> None:
    assert tk._append_images_allowed(reply) is False


@pytest.mark.parametrize(
    "answer",
    [
        # 正常答案里出现「具体是」也不该被误判成澄清
        "第三步具体是这样：打开设置 → 账户 → 添加账户。",
        # 有澄清词但没有问句/列举引导 → 更像顺带提及
        "如果不确定当前版本，可以先看第 3 节的版本对照表。",
        # 纯陈述型答案
        "Outlook 邮箱配置需要填写服务器地址和端口，完成后点测试连接。",
        # 「吗/呢」在正常答案里也会出现，不能单凭它判定
        "Outlook 配置完成后点测试连接就行。如果不行呢，可以检查端口是否填写正确。",
        "报销流程很简单吗？其实不是，需要三步审批。",
        "第3节说明了这种情况。具体是哪一步失败，看日志里的错误码即可。",
    ],
)
def test_normal_answers_still_allow_appendix(answer: str) -> None:
    """不能把正常答案误伤成「澄清轮」——那样用户就再也看不到配图了。"""
    assert tk._append_images_allowed(answer) is True


def test_refusal_still_blocks_appendix() -> None:
    assert tk._append_images_allowed("抱歉，知识库里没有找到相关资料。") is False


# ---- 检索侧：单字符查询不该白送分 ---------------------------------------


@pytest.mark.parametrize("query", ["1", "2", "a", "5"])
def test_single_char_query_is_not_identifying(query: str) -> None:
    assert _has_identifying_query(query) is False


def test_pure_number_query_is_not_identifying() -> None:
    """「42」在正文里俯拾皆是，同样没有辨识度。"""
    assert _has_identifying_query("42") is False


@pytest.mark.parametrize("query", ["报销", "VPN", "Outlook", "会议室", "ok"])
def test_meaningful_query_is_identifying(query: str) -> None:
    assert _has_identifying_query(query) is True


def test_single_char_query_scores_zero_on_arbitrary_text() -> None:
    """「1」出现在这段文本里，但不能再靠整串命中拿 5 分。"""
    text = "第1步：打开设置。第2步：点击添加。第3步：重启客户端。"
    assert _score_single_query("1", text) == 0.0
    assert _score_text("1", text) == 0.0


def test_normal_query_still_scores() -> None:
    """正例：真实查询仍能靠整串命中拿分，别把功能改废。"""
    text = "Outlook 邮箱配置需要填写服务器地址。"
    assert _score_single_query("Outlook", text) > 0
    # 两字符中文查询照旧
    assert _score_single_query("报销", "报销流程：先提交发票。") > 0


def test_single_char_query_cannot_clear_evidence_threshold() -> None:
    """阈值是 2.0，单字符查询必须打不穿它，否则整库都会进证据包。"""
    from app.knowledge.service import SEARCH_MIN_EVIDENCE_SCORE

    arbitrary = "1. 打开 Talents 2. 登录 VPN 3. 配置 Outlook"
    assert _score_text("1", arbitrary) < SEARCH_MIN_EVIDENCE_SCORE