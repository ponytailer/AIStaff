"""PDF 解析产出的一级标题必须是真实文件名。

这段标题不只是排版好看：markdown 的一级标题会成为 chunk 的 ``bucket_title``，
并与页码一起组成 ``section_path``（``<标题> / 第 6 页``）。引用卡片上的来源文字
最终就是由它拼出来的。历史上这里写死 ``# PDF 文档``，于是每个 PDF 的引用都是
「PDF 文档 / 第 6 页」，用户既不知道是哪份文件、也无法判断值不值得点开。
"""

from __future__ import annotations

import pypdf
import pytest

from app.knowledge.parser import KnowledgeParseError, _extract_pdf, extract_document


class _FakePage:
    def __init__(self, text: str) -> None:
        self._text = text

    def extract_text(self) -> str:
        return self._text


class _FakeReader:
    def __init__(self, _content: object) -> None:
        self.pages = [_FakePage("闭门器安装要求"), _FakePage("   "), _FakePage("试验方法")]


@pytest.fixture()
def fake_pdf(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pypdf, "PdfReader", _FakeReader)


def test_pdf_heading_uses_filename_stem(fake_pdf: None) -> None:
    parsed = extract_document("《防火门闭门器》XF 93-2004.pdf", b"%PDF-1.4 ignored")

    assert parsed.file_type == "pdf"
    assert parsed.text.startswith("# 《防火门闭门器》XF 93-2004\n\n")
    # 页码小节照旧，空白页跳过
    assert "## 第 1 页" in parsed.text
    assert "## 第 3 页" in parsed.text
    assert "## 第 2 页" not in parsed.text


def test_pdf_heading_falls_back_without_filename(fake_pdf: None) -> None:
    """文件名为空（内部调用 / 老数据重解析）时退回通用叫法，不能拼出 `# `。"""

    text = _extract_pdf(b"%PDF-1.4 ignored")
    assert text.startswith("# PDF 文档\n\n")


def test_pdf_without_text_layer_returns_empty(fake_pdf: None, monkeypatch: pytest.MonkeyPatch) -> None:
    """没有文字层时返回空串（交给 OCR 兜底），不能靠标题凑出一份假文档。"""

    class _BlankReader:
        def __init__(self, _content: object) -> None:
            self.pages = [_FakePage("")]

    monkeypatch.setattr(pypdf, "PdfReader", _BlankReader)
    assert extract_document("扫描件.pdf", b"%PDF-1.4") .text == ""


def test_unsupported_suffix_still_raises() -> None:
    with pytest.raises(KnowledgeParseError):
        extract_document("报表.xlsx", b"x")