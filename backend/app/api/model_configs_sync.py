"""供外部系统（screenshot-to-code）一键同步模型配置的导出接口。

与 `model_configs.py` 的区别只有一个：**这里返回明文 api_key**。

为什么单独一个文件而不是往 model_configs.py 加：那个模块的每一个读接口都
刻意只返回 `api_key_masked`（列表页、管理页都不该见到明文）。把"唯一会
吐明文"的接口单独放在一起，将来审计"明文从哪出去的"只需要看一个文件。

鉴权沿用普通用户身份（`get_current_user`）—— s2c 前端透传用户在 AIStaff 的
token。**不做服务间密钥**：那需要两边各存一份密钥，而这里读的本来就是
"调用者自己的配置"，用他自己的身份最自然，也最不容易越权。

审计约定：
1. 本模块是全站**唯一**返回明文 api_key 的业务接口。响应里的 `api_key`
   字段只用 `try_decrypt_secret` 解出，且只解**调用者自己**的行。
2. 任何"顺手也带一份明文"的需求都不许复用本模块的序列化函数；要明文就
   走这个接口，让明文出口保持唯一。
3. 过滤条件必须同时包含 `tenant_id` 与 `user_id == current_user.id`，缺一
   不可 —— 少了后者就是越权读别人的 key。
"""

from __future__ import annotations

import logging
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.db.models import ModelConfig, User
from app.llm.model_protocols import LEGACY_OPENAI_PROVIDER, ModelApiProtocol
from app.security.auth import get_current_user, require_current_tenant
from app.security.encryption import try_decrypt_secret
from app.security.tenant import ensure_tenant

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/enterprise/model-configs",
    tags=["enterprise:model-configs"],
    dependencies=[Depends(get_current_user)],
)

# 需要由服务端把根地址补成「OpenAI 客户端可直接使用」形态的协议。
# anthropic / gemini 的 SDK 自己会拼路径，动了反而出错，故不在其中。
_OPENAI_PATH_PROTOCOLS: frozenset[str] = frozenset(
    {
        ModelApiProtocol.OPENAI_CHAT_COMPLETIONS.value,
        ModelApiProtocol.OPENAI_RESPONSES.value,
    }
)

# 用户有可能把「完整端点」存进 base_url（如 .../v1/chat/completions）。
# 长后缀必须排在短后缀之前，否则 `/v1/chat/completions` 会先命中
# `/completions` 被截成 `/v1/chat`。
_OPENAI_ENDPOINT_SUFFIXES: tuple[str, ...] = (
    "/chat/completions",
    "/completions",
    "/responses",
)

_OPENAI_DEFAULT_PATH = "/v1"


class ModelCredentialExport(BaseModel):
    """单条可直连的模型凭据（含明文 key，仅供 s2c 同步使用）。

    `api_key` 用 ``repr=False``：异常栈、调试日志、pytest 的 repr 输出都不该
    带出明文密钥。
    """

    id: str
    name: str
    model: str
    base_url: str | None = None
    api_key: str = Field(default="", repr=False)
    api_protocol: str = ModelApiProtocol.OPENAI_CHAT_COMPLETIONS.value
    provider: str = LEGACY_OPENAI_PROVIDER
    is_default: bool = False
    enabled: bool = False
    # 全局免费模型：由管理员设置、成员自动使用。用户确实在用它，所以同步时
    # 必须包含；但要带标记出去，让 s2c 能提示「这不是你自建的配置」。
    is_global_free: bool = False


def _normalize_for_openai_client(base_url: str | None, api_protocol: str) -> str | None:
    """把 AIStaff 存的 provider 原始 base_url 规整成 OpenAI 客户端能直连的形态。

    为什么需要：AIStaff 存的是 provider 的**根地址**（如
    `https://api.deepseek.com`），而 OpenAI SDK 会在后面拼
    `/chat/completions`，于是最终请求打到 `https://api.deepseek.com/chat/completions`
    —— 少一层 `/v1`，404。

    规则：
    - `openai_chat_completions` / `openai_responses`：若 path 为空或 `/`，
      补 `/v1`；若 path 已经以 `/v1` 结尾（或以 `/v1/` 开头），原样保留。
      其它 path（如 `/api/v3`、`/compatible-mode/v1`）**原样保留** —— 那是
      provider 的定制路径，加 `/v1` 反而会破坏它。
    - 若 path 已经指向具体端点（含 `/chat/completions`、`/completions`、
      `/responses`），先截断到端点之前的 base，再按上面的规则补 `/v1`。
      不截断就会拼出 `/v1/chat/completions/v1` 这种废路径。
    - 其它协议（anthropic / gemini）：**原样返回**。它们的 SDK 自己知道怎么
      拼路径，我们不该动。
    - `None` 或空串：原样返回。
    query / fragment 一律保留。
    """
    if not base_url:
        return base_url

    if api_protocol not in _OPENAI_PATH_PROTOCOLS:
        return base_url

    parsed = urlsplit(base_url.strip())
    if not parsed.netloc:
        # 没有 host 说明不是标准 URL（写路径已被 validate_model_base_url 挡过，
        # 这里只是兜底）。看不懂的就不动，比猜错强。
        return base_url

    # 先去掉尾部 `/`：`.../v1/chat/completions/` 这种从文档里复制来的写法
    # 也要能命中下面的端点后缀。
    path = (parsed.path or "").rstrip("/")

    for suffix in _OPENAI_ENDPOINT_SUFFIXES:
        if path.endswith(suffix):
            path = path[: -len(suffix)]
            break

    path = path.rstrip("/")
    if not path:
        # 纯根地址（`https://api.deepseek.com`）或截断后只剩根地址。
        path = _OPENAI_DEFAULT_PATH
    # 其余路径（`/v1`、`/api/v3`、`/compatible-mode/v1` …）原样保留：
    # 它们要么已经是 OpenAI 形态，要么是 provider 的定制前缀，加 `/v1` 会坏。

    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


def _export_row(row: ModelConfig) -> ModelCredentialExport | None:
    """把一行 ModelConfig 转成导出项；解密失败返回 None 由调用方跳过。

    历史数据可能用旧 APP_SECRET 加密，一条坏数据不该毁掉整个接口 —— 与
    列表接口 `model_config_read` 的容错取向一致，这里只是更严格：key 拿不到
    就等于不可用，直接不透出。
    """
    api_key = try_decrypt_secret(row.api_key_encrypted)
    if not api_key:
        logger.warning(
            "Skip exporting model config %s: api key cannot be decrypted "
            "(likely encrypted with an old APP_SECRET)",
            row.id,
        )
        return None
    return ModelCredentialExport(
        id=row.id,
        name=row.name,
        model=row.model,
        base_url=_normalize_for_openai_client(row.base_url, row.api_protocol),
        api_key=api_key,
        api_protocol=row.api_protocol,
        provider=row.provider,
        is_default=bool(row.is_default),
        enabled=bool(row.enabled),
        is_global_free=bool(row.is_global_free),
    )


@router.get(
    "/export-credentials",
    response_model=list[ModelCredentialExport],
    dependencies=[Depends(require_current_tenant)],
)
def export_model_credentials(
    tenant_id: str = Query(...),
    db: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> list[ModelCredentialExport]:
    """导出调用者本人的模型凭据（含明文 key），供 s2c 一键同步。

    过滤规则与 `list_model_configs` 相同，但有**两处刻意不同**：

    1. **不排除** `is_global_free`。全局免费模型是「成员在免费员工上无自己模型
       时自动使用」的配置，用户可能正在用它。排除掉会让用户看到「AIStaff 里
       没配任何模型」却明明在用 —— 最糟的体验。带上它，并用 `is_global_free`
       字段让 s2c 能标注「这是全局模型，不是你自建的」。
    2. **不排除** `enabled=False`。能不能用交给用户在 s2c 侧判断，后端擅自
       过滤会让「我明明配了 3 个却只看到 2 个」变成难排查的问题。字段里带着
       `enabled` 原值即可。

    排序：`is_default` 优先，其次 `updated_at` 倒序 —— 让 s2c 弹窗的默认选中项
    天然落在第一个。

    安全边界：`user_id == current_user.id` 是硬要求，删掉就会越权返回同租户
    其他用户的密钥。
    """
    ensure_tenant(db, tenant_id)
    filters = [
        ModelConfig.tenant_id == tenant_id,
        ModelConfig.user_id == current_user.id,
    ]
    rows = db.exec(
        select(ModelConfig)
        .where(*filters)
        # is_default 优先（SQLite/MySQL 里 True 排在前，用 desc 达成）；
        # 其次最近更新的优先；最后用 id 兜底，避免同时间戳的行顺序抖动
        # 导致同一份数据两次请求返回顺序不同。
        .order_by(
            ModelConfig.is_default.desc(),
            ModelConfig.updated_at.desc(),
            ModelConfig.id,
        )
    ).all()

    exports: list[ModelCredentialExport] = []
    for row in rows:
        item = _export_row(row)
        if item is not None:
            exports.append(item)
    return exports
