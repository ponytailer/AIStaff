"""一次性修复：场景 v3 的模型列在已有库里缺失（`create_all` 不补列）。

支持 **PostgreSQL**（线上）与 **SQLite**（本地/桌面）。两者由同一份修复清单驱动，
差异集中在 ``Dialect`` 适配层，见下文「双库差异」。

## 根因（为什么这 13 列会漏）

本项目的 schema 动作只有一个：``app.db.database:init_db()`` →
``SQLModel.metadata.create_all()``。而 ``create_all`` 的语义是
**「表不存在才建，已存在则完全跳过」** —— 它不会给已存在的表补列，也不会
给已存在的表补索引。

场景 v3 开发期直接改 ``app/db/models.py``（``HarnessTaskFrameRecord.scene_id``、
``Scene`` 的 8 个模块列、``SceneTable`` 的 3 列、``SceneRun.module_key`` ——
合计 4 张表 13 列），新库由 ``create_all`` 一次建全所以本地毫无感觉；而线上库
这几张表是 v2 时期建的老表，``create_all`` 认为「表已存在」→ 一个列都不补。

于是启动后第一次查 running 帧就炸：

    psycopg2.errors.UndefinedColumn: column harness_task_frames.scene_id does not exist
    [SQL: SELECT ... FROM harness_task_frames WHERE harness_task_frames.status = %s]

## 为什么测试全绿而这个错误在生产必现

测试用 ``tests/dispatch_fixtures.py::memory_session()``：内存 SQLite + ``create_all``，
每次跑测试都是全新 schema。存量库不是 —— 它是「某个历史时刻的 ``create_all`` +
之后所有模型改动」的叠加，而 ``create_all`` 对已存在的表不补列。

所以这个差异是结构性的：**测试库的构建路径与存量库不同**，schema 漂移必然
测不出来。任何「改了 models.py 但没重建库」的环境都会在第一次查询时报
``UndefinedColumn``，且报错指向 SELECT 而不是根因。

要真正堵住这个盲区，需要额外的「schema 一致性测试」：拿一份旧版 schema dump
建库，再让 ``create_all`` 跑一遍，断言列集合与模型一致。本脚本不含这个测试
（超出 BugFix 范围），但它是防止同类问题复发的唯一办法。

## 技术债：这 13 列违反了 ``init_db`` 的加列约定

``app/db/database.py:init_db()`` 的 docstring 要求新增列「带 ``server_default``，
老行自动补齐，不需要数据回填」。而本次这 13 列**只写了 Python 侧 default**
（``Field(default=...)``），``server_default`` 全是 ``None``：

    harness_task_frames.scene_id   null=True   server_default=None   py=None
    scene_runs.module_key          null=False  server_default=None   py=''
    scene_tables.scene_id          null=False  server_default=None   py=''
    scene_tables.order_index       null=False  server_default=None   py=0
    scene_tables.columns_signature null=False  server_default=None   py=''
    scenes.scene_type              null=False  server_default=None   py='table_match'
    scenes.module_key              null=False  server_default=None   py=''
    scenes.module_version          null=False  server_default=None   py=1
    scenes.ui_config_json 等 5 个 JSON 列  null=True  server_default=None  py=None

两个后果，都必须写进脚本而不是靠人记：

1. **DDL 的 DEFAULT 必须脚本自己写**，不能指望从 ``server_default`` 推导。
   PG 分支因此走「ADD(可空) → UPDATE 回填 → SET NOT NULL」三步（不在库里留
   DEFAULT，与模型一致）；SQLite 分支只能一步 ``NOT NULL DEFAULT``（没有
   ``SET NOT NULL``，见下文双库差异）。
2. **影响面有限但真实**：ORM 写入路径不受影响（SQLModel 会填 Python default），
   raw SQL ``INSERT`` 会踩到 NULL。后续如要修，需同时改 ``models.py`` 补
   ``server_default`` 并重跑本脚本 —— 但本脚本不改模型（那会改变新库的 DDL，
   超出本次 BugFix 范围，且这几张表线上是 0 行，没有回填价值）。

## 为什么不能把补列逻辑塞回 ``init_db``

见 ``app/db/database.py:init_db()`` 的 docstring：2026-11-08 已经把历史上那层
「逐条补列」删除，并在注释里写明代价与约定。核心原因——把逐条补列放回启动流程
会让每次启动都在猜测 schema，久了没人敢删；且顺序稍错就出现「先读后补列」的
ORM 报错（正是本次这个报错形态）。所以修复只能是**一次性脚本**，不进 ``init_db``。

## 修什么

- 需要补的列、需要的索引，**不手写 DDL**：直接从 ``SQLModel.metadata`` 读模型
  定义（类型/可空性/默认值/索引名），按目标方言编译成 DDL。
  这样脚本永远不会和模型漂移。
- ``scenes.table_id``：v2 的单值表归属，v3 已删除（改成 ``SceneTable.scene_id``
  的 0..N 归属）。它是 **NOT NULL 且 ORM 已不再写入** → 即使补齐缺列，新建场景
  也会 ``null value in column "table_id" violates not-null constraint``。
  已核对全库无人读它（``app/api/scenes.py`` 只剩一行注释说明它已删除；
  ``SceneTableRow.table_id`` 是另一张表的列，保留）。
- 索引：模型里这些列带 ``index=True``，缺列时索引必然不存在，一并补上。

## 两类「语义回填」（不只是填默认值）

只填模型默认值在**有数据的库**上会造出「能存但跑不起来」的行，所以加了两条
专门的回填，都复用 app 自身的函数作为唯一事实来源：

1. **归属回填**（``scene_tables.scene_id`` ← ``scenes.table_id``）：
   v2 的「场景→表」单值指针必须转成 v3 的「表→场景」归属，否则删掉
   ``scenes.table_id`` 就永久丢失归属关系。映射关系是
   ``scenes.table_id == scene_tables.id``。
2. **module_key 回填**（``scenes.module_key`` ← ``default_module_key(scene_type)``）：
   模型默认值是空串，而 ``runtime.py`` 对空 ``module_key`` 会明确拒绝执行
   （「场景未装配 module_key」）。v2 存量场景全是查表场景，所以按
   ``scene_type`` 走 ``app.scene_modules.constants.default_module_key`` 给出
   ``generic.table_match`` 这类可跑通的值 —— 与建场景接口
   （``app/api/scenes.py``）用的是同一个函数。
3. 附带：``scene_tables.columns_signature`` ← ``columns_signature(columns_json)``，
   复用 ``app.scene_modules.channels.columns_signature``。否则存量表拿到空串，
   下次上传第二张表会把本来同构的表判成不同构。

没有任何数据、或对应列本来就非空时，这些回填自动成为 no-op。

## 双库差异（为什么需要两套 DDL 生成）

SQLite 的 ALTER TABLE 能力远弱于 PostgreSQL，以下全部实测确认（sqlite 3.50.4）：

============================ ================ ==============================
操作                          PostgreSQL       SQLite
============================ ================ ==============================
``ADD COLUMN IF NOT EXISTS`` 支持             **不支持**（语法错误）
``DROP COLUMN IF EXISTS``    支持             **不支持**（语法错误）
``ALTER COLUMN SET NOT NULL`` 支持            **不支持**（语法错误）
``ADD COLUMN ... NOT NULL``   支持（非空表需默认值） 非空表**必须**带默认值
有索引时 ``DROP COLUMN``      自动连带删索引    **报错**，须先 DROP INDEX
被 UNIQUE 引用的列 DROP       受阻需 CASCADE    **报错**
============================ ================ ==============================

因此 SQLite 分支：
- 幂等靠**先查 PRAGMA 再决定是否生成语句**（没有 IF NOT EXISTS 可用）；
- 列已被 UNIQUE 约束引用时给 ``表设计需重构`` 的报错，不做 ``CASCADE``；
- 删列前先自动 ``DROP INDEX``（模型里该列的单列索引）；
- ``ALTER COLUMN SET NOT NULL`` 不可用 → 改用 ``ADD COLUMN ... NOT NULL DEFAULT``
  一次到位。**代价**：SQLite 的 ``PRAGMA table_info`` 会因此显示一个
  default 值，而模型没有 ``server_default``。这是 SQLite 的硬限制，无法两全；
  对 ORM 无影响（ORM 总是显式赋值），故可接受。

## 用法（在 backend/ 下）

    .venv/bin/python scripts/fix_scene_v3_schema.py                # dry-run
    .venv/bin/python scripts/fix_scene_v3_schema.py --verify        # 事务内实跑再 ROLLBACK
    .venv/bin/python scripts/fix_scene_v3_schema.py --apply          # 真正执行并提交
    .venv/bin/python scripts/fix_scene_v3_schema.py --database-url 'sqlite:///xxx.db'
    .venv/bin/python scripts/fix_scene_v3_schema.py --source-check   # 只校验修复清单

``--verify`` 在**不写库**的前提下让数据库真实执行每一条 DDL（跑完显式 ROLLBACK，
库里不留任何痕迹）。``--apply`` 才提交。``--database-url`` 覆盖 ``DATABASE_URL``，
便于对本地 SQLite 库或临时副本事先生成/验证计划。

### 线上执行的安全绳：``lock_timeout``

``ALTER TABLE`` 要拿 ``ACCESS EXCLUSIVE`` 锁，一旦库里还有**未提交**的事务
（典型来源：后端某个请求卡在慢查询、或有人开着 pgAdmin 事务没关），本脚本会
无限期等锁，而它后面的**所有**普通 SELECT/INSERT 又被排在它后面 —— 表现为
「修个 schema 把线上写挂了」。

所以线上 ``--apply`` 请带上这句：

    PGOPTIONS='-c lock_timeout=3s' .venv/bin/python scripts/fix_scene_v3_schema.py --apply

等锁超过 3 秒就抛 ``canceling statement due to lock timeout``，脚本走「任一句
失败即整体 ROLLBACK」的分支干净退出，不会挂死，也不会留下半修的库。重试即可。
（``statement_timeout`` 不必设：单条 DDL 在 331 行的表上是毫秒级。）

## 幂等与事务

- 所有语句都按「先查存在性，再决定是否生成」的路径产出；PostgreSQL 额外用
  ``IF NOT EXISTS`` 兜底。重复执行生成 **0** 条语句。
- ``--apply`` / ``--verify`` 全部语句在**一个事务**里，任一句失败整体 ROLLBACK。
  两库的 DDL 都可事务回滚（SQLite 亦如此，已实测）。
- ``NOT NULL`` + 无 ``server_default`` 的列：
  - PostgreSQL 走 ``ADD COLUMN(可空) → UPDATE 回填 → SET NOT NULL`` 三步；
  - SQLite 走 ``ADD COLUMN ... NOT NULL DEFAULT <值>`` 一步。
  两者都不依赖「表恰好是空表」，331 行的 ``harness_task_frames`` 也安全。

## 只读模型，不改模型

模型是对的，库是旧的。本脚本不修改 ``models.py``，也不修改 ``init_db``。
"""

from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import Table
from sqlalchemy.dialects import postgresql, sqlite
from sqlmodel import SQLModel

from app.config import get_settings
from app.db.database_path import normalize_database_url, sqlite_database_path

PG_DIALECT = postgresql.dialect()
SQLITE_DIALECT = sqlite.dialect()


# ---------------------------------------------------------------------------
# 修复清单：只声明「表.列 → 为什么」，DDL 由模型 + 方言推导
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ColumnFix:
    """一条列级修复的意图声明（不含 DDL 细节）。"""

    table: str
    column: str
    reason: str


# 13 个缺列（4 张表）。刻意逐条写出来（而不是「模型有、库没有」全自动扫），因为:
# 1. 库里还有 3 张表存在**可空**的遗留列（a2a_task_runs.codex_session_id、
#    sessions.channel_account_key / channel_target_json、tenants.seed_fingerprint），
#    它们不阻塞 ORM，不属于本次修复范围，不能被「全自动」逻辑顺手删掉；
# 2. 一次性脚本的爆炸半径应该显式可见。
COLUMNS_TO_ADD: tuple[ColumnFix, ...] = (
    # 启动即崩的那一列（线上 331 行存量数据必须保留）
    ColumnFix(
        "harness_task_frames",
        "scene_id",
        "场景帧专用列；缺它启动查 running 帧即 UndefinedColumn（本次报错根因）",
    ),
    ColumnFix("scene_runs", "module_key", "冗余模块 key，便于按模块筛排障记录"),
    ColumnFix("scene_tables", "scene_id", "v3 归属列：表属于哪个场景（替代 scenes.table_id）"),
    ColumnFix("scene_tables", "order_index", "合并池内次序，多表拼行时保证结果可复现"),
    ColumnFix("scene_tables", "columns_signature", "列结构指纹，用于第二张表秒判同构"),
    ColumnFix("scenes", "scene_type", "通道四选一的事实来源"),
    ColumnFix("scenes", "module_key", "前端渲染目录名（唯一事实来源）"),
    ColumnFix("scenes", "module_version", "模块版本"),
    ColumnFix("scenes", "ui_config_json", "定义器里配的展示参数"),
    ColumnFix("scenes", "module_config_json", "模块私有状态"),
    ColumnFix("scenes", "flow_json", "sop_flow 的流程定义"),
    ColumnFix("scenes", "handoff_json", "handoff 的转人工参数"),
    ColumnFix("scenes", "scripts_json", "script 的话术表"),
    ColumnFix("scenes", "tool_api_json", "tool_submit 的接口调用配置（与 module_config 分工不同）"),
)


# 需要删掉的遗留列（v3 语义变更，不是「漏建」）
COLUMNS_TO_DROP: tuple[ColumnFix, ...] = (
    ColumnFix(
        "scenes",
        "table_id",
        "v2 的单值表归属，v3 已删除（改 SceneTable.scene_id 的 0..N 归属）；"
        "NOT NULL 且 ORM 不再写 → 不删则新建场景必踩 not-null 约束",
    ),
)


@dataclass
class Statement:
    """一条待执行语句。

    ``params`` 非空时走参数绑定（用于 UPDATE 回填）。

    ``require_verified`` 非空时表示「执行前必须再跑一次这张表的守卫，返回 0 个
    违例行才放行」——给不可逆的 ``DROP COLUMN`` 用。计划构建期的检查发生在读
    事务里，到真正执行之间可能有并发写入；删列会连带丢掉该列数据，所以执行
    瞬间要再拦一次，而不是只信规划期的快照。
    """

    sql: str
    params: tuple[Any, ...] | None = None
    note: str = ""
    require_verified: str | None = None


@dataclass
class TableReport:
    """单表的修复前后对照。"""

    table: str
    rows: int = 0
    cols_before: int = 0
    cols_after: int = 0
    added: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)
    indexes: list[str] = field(default_factory=list)
    backfilled: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


@dataclass
class Plan:
    """完整执行计划。"""

    statements: list[Statement] = field(default_factory=list)
    reports: dict[str, TableReport] = field(default_factory=dict)
    blocked: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 模型侧：读 metadata（不连库）
# ---------------------------------------------------------------------------


def _load_tables() -> dict[str, Table]:
    """导入模型并返回 ``{表名: Table}``（只读 ``SQLModel.metadata``）。"""
    import app.db.models  # noqa: F401  仅为了把模型注册进 metadata

    return {table.name: table for table in SQLModel.metadata.sorted_tables}


def _model_index_name(table: Table, column_name: str) -> str | None:
    """返回模型里作用在**单列**上的索引名；没有则 None。"""
    for index in table.indexes:
        if [col.name for col in index.columns] == [column_name]:
            return index.name
    return None


def _python_default_literal(column: Any) -> Any | None:
    """取模型列的 Python 侧默认值（``Field(default=...)``），用于回填老行。"""
    default = column.default
    if default is None or not getattr(default, "is_scalar", False):
        return None
    return default.arg


def _safe_fetchall(cur: Any, sql: str, params: tuple[Any, ...] = ()) -> list[Any] | None:
    """在 SAVEPOINT 里执行「可能失败」的探测查询；失败返回 None。

    为什么必须用 SAVEPOINT：PostgreSQL 里任何一条语句报错都会把**整个事务**
    置为 aborted，之后所有命令都被拒绝（``InFailedSqlTransaction``）。而本脚本
    在计划阶段需要探性地查「表/列是否已存在」——例如 ``scenes.scene_type``
    还没补上时，按它算 module_key 的查询必然失败。裸 ``try/except`` 吞掉异常
    并不能让事务复活，所以必须把探测包进 savepoint：失败只回滚到 savepoint，
    外层事务仍然可用。SQLite 同样支持 SAVEPOINT，语义一致。
    """
    cur.execute("SAVEPOINT probe")
    try:
        cur.execute(sql, params)
        rows = cur.fetchall()
    except Exception:  # noqa: BLE001 - 探测失败即「不可判定」，由调用方决定后果
        cur.execute("ROLLBACK TO SAVEPOINT probe")
        cur.execute("RELEASE SAVEPOINT probe")
        return None
    cur.execute("RELEASE SAVEPOINT probe")
    return rows


def _safe_scalar(cur: Any, sql: str, params: tuple[Any, ...] = ()) -> int | None:
    """``_safe_fetchall`` 的标量版（取第一行第一列）。"""
    rows = _safe_fetchall(cur, sql, params)
    if not rows:
        return None
    return int(rows[0][0])


def _normalize_type_name(raw: str) -> str:
    """把类型名归一化，消除方言别名差异。

    ``pg_catalog`` 报 ``character varying``、SQLAlchemy 编译出 ``VARCHAR``，
    SQLite ``PRAGMA`` 又报 ``VARCHAR(255)`` —— 都是同一类型。不归一化会得到
    满屏假阳性。
    """
    aliases = {
        "varchar": "character varying",
        "character varying": "character varying",
        "nvarchar": "character varying",
        "int4": "integer",
        "int": "integer",
        "int8": "bigint",
        "bool": "boolean",
        "float8": "double precision",
        "float4": "real",
        "timestamp": "timestamp without time zone",
        "datetime": "timestamp without time zone",
        "timestamptz": "timestamp with time zone",
        "text": "character varying",
    }
    base = raw.lower().split("(")[0].strip()
    return aliases.get(base, base)


# ---------------------------------------------------------------------------
# 语义回填：复用 app 自身的唯一事实来源
# ---------------------------------------------------------------------------


def _module_key_by_scene_type() -> dict[str, str]:
    """``scene_type → 默认 module_key``，直接取自 app 的常量表。

    不手抄映射：建场景接口用的就是 ``default_module_key``，两处必须同源，
    否则回填出来的 key 会和新建场景的 key 不一致。
    """
    from app.scene_modules.constants import SCENE_TYPES, default_module_key

    return {scene_type: default_module_key(scene_type) for scene_type in SCENE_TYPES}


def _columns_signature_of(columns_json: Any) -> str | None:
    """按 app 的算法算出 ``columns_signature``；``columns_json`` 不可解析时返回 None。

    返回 None 表示「这行的列结构无法判定」，调用方应留空串并记录下来 ——
    这不是错误，是存量脏数据的降级路径。

    ``columns_json`` 可能脏得超出想象（历史数据是手写的、或早期版本存了别的
    结构），两种不可解析形态都要覆盖：

    1. **不是 JSON** → ``json.loads`` 抛 ``ValueError``；
    2. **是 JSON 但不是「列定义列表」** → ``channels.normalize_column`` 里
       ``raw.get("key")`` 对非 dict 元素（``[1,2]`` / ``[null]`` / ``["a"]``）
       抛 ``AttributeError``。注意是 ``AttributeError`` 而不是 ``TypeError``
       —— 这是 Python 的 ``int.get`` 不存在的报错类型。

    这里**显式列出**这四种异常类型而不用 ``except Exception``：宽捕获会把
    ``normalize_column`` 里真正的 bug（比如改了字段名导致 KeyError 之外的错）
    一起吞掉，让脏数据问题永远静默。
    """
    import json

    from app.scene_modules.channels import columns_signature

    raw = columns_json
    if isinstance(raw, (str, bytes)):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return None
    if not isinstance(raw, list):
        return None
    try:
        return columns_signature(raw)
    except (AttributeError, ValueError, TypeError, KeyError):
        return None


# ---------------------------------------------------------------------------
# 方言适配层
# ---------------------------------------------------------------------------


class Dialect(ABC):
    """数据库方言适配器：所有库差异都收敛在这里。

    上层（``build_plan`` / ``main``）只跟这个接口打交道，因此新增一种后端
    只需要再实现一个子类，不必改计划构建与执行流程。
    """

    #: 输出用的人类可读名字
    label: str = ""

    #: 参数占位符（psycopg2 用 %s，sqlite3 用 ?）
    placeholder: str = "%s"

    #: 编译列类型用的 SQLAlchemy 方言
    sqlalchemy_dialect: Any = None

    @abstractmethod
    def connect(self) -> Any:
        """打开连接，``autocommit``/事务语义由调用方控制。"""

    @abstractmethod
    def tables(self, cur: Any) -> set[str]:
        """库中已存在的表名集合。"""

    @abstractmethod
    def columns(self, cur: Any, table_name: str) -> dict[str, tuple[str, bool]]:
        """``{列名: (归一化类型, 是否可空)}``，按定义顺序。"""

    @abstractmethod
    def indexes(self, cur: Any, table_name: str) -> set[str]:
        """库中已存在的索引名集合。"""

    @abstractmethod
    def row_count(self, cur: Any, table_name: str) -> int: ...

    @abstractmethod
    def add_column(
        self, table: Table, column_name: str, row_count: int
    ) -> tuple[list[Statement], str]:
        """补一列的语句；第二个返回值非空表示「跳过并说明原因」。"""

    @abstractmethod
    def drop_column(
        self,
        cur: Any,
        fix: ColumnFix,
        table: Table,
        columns: dict[str, tuple[str, bool]],
        row_count: int,
        report: TableReport,
    ) -> list[Statement]:
        """删遗留列的语句（含方言特有的前置动作与守卫）。

        ``report`` 用于记录「本方言能力不足、主动跳过」之类非致命信息 ——
        跳过不是错误，但必须让执行者在输出里看见，不能静默。
        """

    def create_index(self, table: Table, column_name: str, existing: set[str]) -> Statement | None:
        """补一条单列索引；模型没声明索引或库里已有则返回 None。

        ``CREATE INDEX IF NOT EXISTS`` 两库都支持，故放在基类。
        """
        column = table.columns.get(column_name)
        if column is None or not column.index:
            return None
        name = _model_index_name(table, column_name) or f"ix_{table.name}_{column_name}"
        if name in existing:
            return None
        return Statement(f"CREATE INDEX IF NOT EXISTS {name} ON {table.name} ({column_name});")

    def verdict(self, cur: Any, tables: dict[str, Table]) -> bool:
        """修复后复核：列集合、类型、可空性、索引是否与模型一致。"""
        clean = True
        checked = {fix.table for fix in COLUMNS_TO_ADD} | {fix.table for fix in COLUMNS_TO_DROP}
        for table_name in sorted(checked):
            table = tables.get(table_name)
            if table is None:
                clean = False
                print(f"  [残留] {table_name}: 模型里找不到这张表")
                continue
            live = self.columns(cur, table_name)
            index_names = self.indexes(cur, table_name)

            missing_columns = [c.name for c in table.columns if c.name not in live]
            dropped_columns = [
                fix.column
                for fix in COLUMNS_TO_DROP
                if fix.table == table_name and fix.column in live
            ]
            shape_mismatch = {}
            for column in table.columns:
                if column.name not in live:
                    continue
                expected = (
                    _normalize_type_name(column.type.compile(dialect=self.sqlalchemy_dialect)),
                    column.nullable,
                )
                if expected != live[column.name]:
                    shape_mismatch[column.name] = {
                        "expected": expected,
                        "live": live[column.name],
                    }
            missing_indexes = [
                name
                for column in table.columns
                if column.index
                for name in [_model_index_name(table, column.name)]
                if name and name not in index_names
            ]

            if missing_columns or dropped_columns or shape_mismatch or missing_indexes:
                clean = False
                print(
                    f"  [残留] {table_name}: 缺列={missing_columns} 未删列={dropped_columns} "
                    f"类型/可空不符={shape_mismatch} 缺索引={missing_indexes}"
                )
        if clean:
            print(
                f"复核通过（{self.label}）：{len(checked)} 张表的模型列（含类型/可空）"
                f"与索引全部在位，遗留列已清理。"
            )
            for note in self.post_verdict_notes():
                print(f"  注意：{note}")
        return clean

    def post_verdict_notes(self) -> list[str]:
        """复核通过后需要向执行者交代的方言特有事实。"""
        return []

    def guard_count(self, cur: Any, guard: str) -> int:
        """执行删列守卫，返回「违例行数」；查不出来（列/表缺失）视为 0。"""
        return _safe_scalar(cur, guard) or 0


class PostgresDialect(Dialect):
    """PostgreSQL：能力最全，DDL 直接带 ``IF NOT EXISTS`` / ``SET NOT NULL``。"""

    label = "PostgreSQL"
    placeholder = "%s"
    sqlalchemy_dialect = PG_DIALECT

    def __init__(self, dsn: dict[str, Any]) -> None:
        self._dsn = dsn

    def connect(self) -> Any:
        import psycopg2

        connection = psycopg2.connect(**self._dsn)
        connection.autocommit = False
        return connection

    def tables(self, cur: Any) -> set[str]:
        cur.execute(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
        )
        return {row[0] for row in cur.fetchall()}

    def columns(self, cur: Any, table_name: str) -> dict[str, tuple[str, bool]]:
        cur.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = %s "
            "ORDER BY ordinal_position",
            (table_name,),
        )
        return {
            name: (_normalize_type_name(data_type), is_nullable == "YES")
            for name, data_type, is_nullable in cur.fetchall()
        }

    def indexes(self, cur: Any, table_name: str) -> set[str]:
        cur.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = current_schema() AND tablename = %s",
            (table_name,),
        )
        return {row[0] for row in cur.fetchall()}

    def row_count(self, cur: Any, table_name: str) -> int:
        cur.execute(f"SELECT count(*) FROM {table_name}")  # 表名来自模型常量，非用户输入
        return int(cur.fetchone()[0])

    def add_column(
        self, table: Table, column_name: str, row_count: int
    ) -> tuple[list[Statement], str]:
        """补一列。

        三种情形：
        1. 可空列 → 一句 ``ADD COLUMN IF NOT EXISTS``；
        2. NOT NULL + 有 ``server_default`` → 一句带 DEFAULT 的 ADD COLUMN；
        3. NOT NULL + 无 ``server_default`` → ``ADD(可空) → UPDATE 回填 → SET NOT NULL``。
           直接 ``ADD COLUMN ... NOT NULL`` 无默认值在**非空表**上会
           ``column contains null values`` 报错；三步走对 0 行和 N 行都成立，
           且不在库里留 server_default（与模型一致）。
        """
        column = table.columns.get(column_name)
        if column is None:
            return [], f"模型里没有 {table.name}.{column_name}（模型已改名？请同步本脚本）"

        type_sql = column.type.compile(dialect=PG_DIALECT)
        head = f"ALTER TABLE {table.name} ADD COLUMN IF NOT EXISTS {column.name} {type_sql}"

        if column.nullable:
            return [Statement(f"{head};")], ""

        if column.server_default is not None:
            default_sql = column.server_default.arg
            literal = str(default_sql) if not isinstance(default_sql, str) else f"'{default_sql}'"
            return [Statement(f"{head} DEFAULT {literal} NOT NULL;")], ""

        python_default = _python_default_literal(column)
        if python_default is None:
            if row_count > 0:
                return [], (
                    f"NOT NULL 且无任何默认值，表内已有 {row_count} 行 —— "
                    f"无法自动填充，需要人工决定语义"
                )
            # 空表无行可违约，直接加 NOT NULL 也安全
            return [Statement(f"{head} NOT NULL;")], ""

        return (
            [
                Statement(f"{head};"),
                Statement(
                    f"UPDATE {table.name} SET {column.name} = {self.placeholder} "
                    f"WHERE {column.name} IS NULL;",
                    (python_default,),
                    note=f"回填 {row_count} 行老数据为模型默认值 {python_default!r}",
                ),
                Statement(f"ALTER TABLE {table.name} ALTER COLUMN {column.name} SET NOT NULL;"),
            ],
            "",
        )

    def drop_column(
        self,
        cur: Any,
        fix: ColumnFix,
        table: Table,
        columns: dict[str, tuple[str, bool]],
        row_count: int,
        report: TableReport,
    ) -> list[Statement]:
        """删遗留列：行数闸 + 外键闸 + 视图闸，任一不过就 SystemExit。

        删列不可逆，所以不静默跳过，把决定权交回给人。
        """
        if fix.column not in columns:
            return []

        guard = self.drop_guard_sql(fix)
        violations = self.guard_count(cur, guard)
        if violations:
            raise SystemExit(self._guard_message(fix, row_count, violations))

        fk_rows = _safe_fetchall(
            cur,
            "SELECT c.conname FROM pg_constraint c "
            "WHERE c.contype = 'f' "
            "AND (c.confrelid = to_regclass(%s) OR c.conrelid = to_regclass(%s))",
            (fix.table, fix.table),
        )
        if fk_rows:
            raise SystemExit(f"[!] {fix.table} 上存在外键约束，DROP COLUMN 前请人工确认依赖关系")

        view_count = _safe_scalar(
            cur,
            "SELECT count(*) FROM pg_depend d JOIN pg_rewrite r ON r.oid = d.objid "
            "JOIN pg_class v ON v.oid = r.ev_class "
            "WHERE v.relkind = 'v' AND d.refobjid = to_regclass(%s)",
            (fix.table,),
        )
        if view_count:
            raise SystemExit(f"[!] 有视图依赖 {fix.table}，DROP COLUMN 前请人工确认")

        return [
            Statement(
                f"ALTER TABLE {fix.table} DROP COLUMN IF EXISTS {fix.column};",
                note=fix.reason,
                require_verified=guard,
            )
        ]

    def drop_guard_sql(self, fix: ColumnFix) -> str:
        """删列前的守卫：返回「违例行数」的 SQL，0 才放行。

        ``scenes.table_id`` 的守卫是**数据完整性**：存量场景引用的表必须已经
        归到该场景名下（v2 指针已成功转成 v3 归属）。若仍有不一致，说明归属
        回填没覆盖到，此时删列就会永久丢归属。

        必须显式写 ``IS NULL OR``：``NULL <> 'x'`` 在 SQL 三值逻辑里求值为
        ``NULL``，不满足 ``WHERE`` 因而不被 count 计入。半途态「列已加但全是
        NULL」（比如上一次运行在 ADD COLUMN 之后崩了）会被漏判为 0 违例。
        下游 ``verdict()`` 复核确实还会兜住（NULL 与新补列的模型默认值不符），
        但守卫该挡的自己挡 —— 不能依赖下游兜底。
        """
        if (fix.table, fix.column) == ("scenes", "table_id"):
            return (
                "SELECT count(*) FROM scenes s "
                "JOIN scene_tables t ON t.id = s.table_id "
                "WHERE t.scene_id IS NULL OR t.scene_id <> s.id"
            )
        return f"SELECT count(*) FROM {fix.table}"

    def _guard_message(self, fix: ColumnFix, row_count: int, violations: int) -> str:
        if (fix.table, fix.column) == ("scenes", "table_id"):
            return (
                f"[!] {fix.table}.{fix.column} 删除前守卫未通过："
                f"{violations} 条场景的表归属尚未正确回填。\n"
                f"    原因：{fix.reason}\n"
                f"    请先修好 scene_tables.scene_id 与 scenes.table_id 的对应关系，"
                f"再重跑本脚本。"
            )
        return (
            f"[!] {fix.table} 有 {row_count} 行数据，拒绝自动 DROP COLUMN {fix.column}。\n"
            f"    原因：{fix.reason}\n"
            f"    请先人工确认存量数据无需保留该列，再手工执行 "
            f"ALTER TABLE {fix.table} DROP COLUMN {fix.column};"
        )


class SQLiteDialect(Dialect):
    """SQLite：没有 IF NOT EXISTS / SET NOT NULL，全靠 PRAGMA 预判。

    DDL 全部实测确认（sqlite 3.50.4）：
    - ``ADD COLUMN IF NOT EXISTS`` → 语法错误，必须先用 ``PRAGMA table_info`` 判重；
    - ``DROP COLUMN IF EXISTS`` → 语法错误，同上；
    - ``ALTER COLUMN SET NOT NULL`` → 语法错误，只能用 ``NOT NULL DEFAULT`` 一次加；
    - 非空表上 ``ADD COLUMN ... NOT NULL`` 无默认值 → ``Cannot add a NOT NULL
      column with default value NULL``；
    - 被索引引用的列 ``DROP COLUMN`` → ``error in index ... after drop column``，
      必须先 ``DROP INDEX``；
    - 被 UNIQUE 约束引用的列 ``DROP COLUMN`` → 报错，且 SQLite 无 ``CASCADE``。
    """

    label = "SQLite"
    placeholder = "?"
    sqlalchemy_dialect = SQLITE_DIALECT

    def __init__(self, path: str) -> None:
        self._path = path

    def post_verdict_notes(self) -> list[str]:
        """交代 SQLite 的已知妥协：NOT NULL 新列必须带 DEFAULT。

        SQLite 没有 ``ALTER COLUMN SET NOT NULL``，所以「NOT NULL 且无默认值」的
        列只能靠 ``ADD COLUMN ... NOT NULL DEFAULT <值>`` 一次加。结果是
        ``PRAGMA table_info`` 里会留下一个 default 值，而模型没有
        ``server_default`` —— 这属于方言限制，不是脚本 bug。
        """
        return [
            (
                "SQLite 无 ALTER COLUMN SET NOT NULL，NOT NULL 新列是以 "
                "`ADD COLUMN ... NOT NULL DEFAULT <模型默认值>` 一次加上的。"
                "因此这些列在 PRAGMA 里会显示 DEFAULT，而模型并未声明 server_default "
                "（ORM 总是显式赋值，不影响行为）。若要彻底对齐，需整表重建。"
            )
        ]

    def connect(self) -> Any:
        """打开连接并**立刻探活**，把 ``sqlite3`` 的懒报错提前成友好提示。

        ``sqlite3.connect()`` 不校验文件内容 —— 指向非 SQLite 文件（比如一个
        HTML 报错页、一个 tar 包）或指向目录时，它要么成功返回一个「看起来
        正常」的连接，要么抛裸 ``OperationalError``。真正的
        ``file is not a database`` 要等到第一次执行 SQL 才出现，那时已经深入
        ``tables()``，往上就是 traceback。

        所以在 ``connect()`` 里就跑一次 ``SELECT count(*) FROM sqlite_master``：
        这是任何合法 SQLite 库都能回答的查询，能一次性暴露「不是数据库」
        「无法打开」「文件损坏」三类问题。报错统一转成中文 + ``SystemExit``。
        """
        # isolation_level=None -> 由脚本显式 BEGIN / COMMIT / ROLLBACK 控制，
        # 避免 sqlite3 隐式开事务导致 DDL 不在同一个事务里。
        try:
            connection = sqlite3.connect(self._path, isolation_level=None)
        except sqlite3.Error as exc:
            raise SystemExit(
                f"[!] 无法打开数据库文件：{self._path}\n"
                f"    SQLite 报错：{exc}\n"
                f"    请确认路径指向一个文件（不是目录），且有读写权限。"
            ) from None

        try:
            connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except sqlite3.DatabaseError as exc:
            connection.close()
            # "file is not a database" 是最常见的一种：路径存在但内容不是库
            raise SystemExit(
                f"[!] 不是有效的 SQLite 库：{self._path}\n"
                f"    SQLite 报错：{exc}\n"
                f"    请确认这是本项目的 skill_agent_loop.db（可用 "
                f"`file <path>` 核对），或把 --database-url 指向正确的文件。"
            ) from None

        connection.execute("PRAGMA foreign_keys = OFF")
        return connection

    def tables(self, cur: Any) -> set[str]:
        cur.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        return {row[0] for row in cur.fetchall() if not row[0].startswith("sqlite_")}

    def columns(self, cur: Any, table_name: str) -> dict[str, tuple[str, bool]]:
        cur.execute(f"PRAGMA table_info({table_name})")
        # PRAGMA table_info 列序: cid, name, type, notnull, dflt_value, pk
        return {
            row[1]: (_normalize_type_name(row[2] or ""), int(row[3]) == 0) for row in cur.fetchall()
        }

    def indexes(self, cur: Any, table_name: str) -> set[str]:
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
            (table_name,),
        )
        # sqlite_autoindex_* 是约束自动生成的索引，模型里没有，排除
        return {row[0] for row in cur.fetchall() if not row[0].startswith("sqlite_autoindex")}

    def row_count(self, cur: Any, table_name: str) -> int:
        cur.execute(f"SELECT count(*) FROM {table_name}")
        return int(cur.fetchone()[0])

    def add_column(
        self, table: Table, column_name: str, row_count: int
    ) -> tuple[list[Statement], str]:
        """补一列：SQLite 没有 ``SET NOT NULL``，所以 NOT NULL 列必须一次到位。

        ``ADD COLUMN ... NOT NULL DEFAULT <模型默认值>`` 对空表和非空表都成立
        （实测）。代价是库里留下一个 DEFAULT，见模块 docstring 的说明。
        """
        column = table.columns.get(column_name)
        if column is None:
            return [], f"模型里没有 {table.name}.{column_name}（模型已改名？请同步本脚本）"

        type_sql = column.type.compile(dialect=SQLITE_DIALECT)
        head = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {type_sql}"

        if column.nullable:
            return [Statement(f"{head};")], ""

        default_value = self._not_null_default(column)
        if default_value is None:
            if row_count > 0:
                return [], (
                    f"NOT NULL 且无任何默认值，表内已有 {row_count} 行 —— "
                    f"SQLite 无法自动填充，需要人工决定语义"
                )
            return [Statement(f"{head} NOT NULL;")], ""

        literal = self._sql_literal(default_value)
        return [Statement(f"{head} NOT NULL DEFAULT {literal};")], ""

    @staticmethod
    def _not_null_default(column: Any) -> Any | None:
        """NOT NULL 列可用的默认值：优先 server_default，退回 Python 默认。"""
        if column.server_default is not None:
            return column.server_default.arg
        return _python_default_literal(column)

    @staticmethod
    def _sql_literal(value: Any) -> str:
        if isinstance(value, bool):
            return "1" if value else "0"
        if isinstance(value, (int, float)):
            return str(value)
        if value is None:
            return "NULL"
        return "'" + str(value).replace("'", "''") + "'"

    def drop_column(
        self,
        cur: Any,
        fix: ColumnFix,
        table: Table,
        columns: dict[str, tuple[str, bool]],
        row_count: int,
        report: TableReport,
    ) -> list[Statement]:
        """删遗留列：先解索引，再用「归属已回填」守卫，最后才 DROP。

        SQLite 没有 ``IF EXISTS`` / ``CASCADE``，所以每一步都先查 PRAGMA。
        """
        if fix.column not in columns:
            return []

        # DROP COLUMN 是 sqlite 3.35 才有的能力；打包版可能随附更老的 runtime。
        # 低版本不硬来（重建表涉及数据迁移，超出一次性脚本范围），只跳过删列。
        if sqlite3.sqlite_version_info < (3, 35):
            report.skipped.append(
                f"{fix.table}.{fix.column}：当前 SQLite {sqlite3.sqlite_version} < 3.35，"
                f"不支持 DROP COLUMN，已跳过。该列保留不影响启动，"
                f"但新建场景仍会被它的 NOT NULL 约束拦住，需升级 runtime 或手工重建表。"
            )
            return []

        guard = self.drop_guard_sql(fix)
        violations = self.guard_count(cur, guard)
        if violations:
            raise SystemExit(self._guard_message(fix, row_count, violations))

        # 被 UNIQUE 约束引用的列，SQLite 无法 DROP（没有 CASCADE）
        if self._referenced_by_unique(cur, fix.table, fix.column):
            raise SystemExit(
                f"[!] {fix.table}.{fix.column} 被 UNIQUE 约束引用，SQLite 无法 DROP COLUMN。\n"
                f"    需要重建该表（SQLite 没有 ALTER ... CASCADE），请人工处理。"
            )

        statements: list[Statement] = []
        # 先删引用该列的单列索引，否则 DROP COLUMN 直接报错：
        #   error in index ix_scenes_table_id after drop column: no such column
        index_name = _model_index_name(table, fix.column) or f"ix_{fix.table}_{fix.column}"
        if index_name in self.indexes(cur, fix.table):
            statements.append(
                Statement(
                    f"DROP INDEX IF EXISTS {index_name};",
                    note=f"SQLite 要求先解索引才能删列（{fix.column}）",
                )
            )
        statements.append(
            Statement(
                f"ALTER TABLE {fix.table} DROP COLUMN {fix.column};",
                note=fix.reason,
                require_verified=guard,
            )
        )
        return statements

    @staticmethod
    def _referenced_by_unique(cur: Any, table_name: str, column_name: str) -> bool:
        """查该列是否出现在表的 UNIQUE 约束里（含表级与列级）。"""
        cur.execute(f"PRAGMA index_list({table_name})")
        for row in cur.fetchall():
            # 列序: seq, name, unique, origin, partial
            index_name, is_unique, origin = row[1], int(row[2]), row[3]
            if not is_unique or origin == "pk":
                continue
            cur.execute(f"PRAGMA index_info({index_name})")
            if any(info[2] == column_name for info in cur.fetchall()):
                return True
        return False

    def drop_guard_sql(self, fix: ColumnFix) -> str:
        """删列前的守卫：返回「违例行数」的 SQL，0 才放行。

        SQLite 侧的 ``scenes.table_id`` 守卫与 PG 同义：存量场景引用的表必须
        已归到该场景名下。本地库往往**有数据**（这是它区别于线上库的关键），
        所以这条守卫比 PG 那边更常真正起作用。

        ``IS NULL OR`` 与 PG 侧同理：``NULL <> 'x'`` 求值为 NULL 不计入 count，
        半途态「列已加但全 NULL」会被漏判。两处必须保持逐字一致，否则同一个
        库在两种方言下会得出不同结论。
        """
        if (fix.table, fix.column) == ("scenes", "table_id"):
            return (
                "SELECT count(*) FROM scenes s "
                "JOIN scene_tables t ON t.id = s.table_id "
                "WHERE t.scene_id IS NULL OR t.scene_id <> s.id"
            )
        return f"SELECT count(*) FROM {fix.table}"

    @staticmethod
    def _guard_message(fix: ColumnFix, row_count: int, violations: int) -> str:
        if (fix.table, fix.column) == ("scenes", "table_id"):
            return (
                f"[!] {fix.table}.{fix.column} 删除前守卫未通过："
                f"{violations} 条场景的表归属尚未正确回填。\n"
                f"    原因：{fix.reason}\n"
                f"    请先修好 scene_tables.scene_id 与 scenes.table_id 的对应关系，"
                f"再重跑本脚本。"
            )
        return (
            f"[!] {fix.table} 有 {row_count} 行数据，拒绝自动 DROP COLUMN {fix.column}。\n"
            f"    原因：{fix.reason}\n"
            f"    请先人工确认存量数据无需保留该列，再手工执行 "
            f"ALTER TABLE {fix.table} DROP COLUMN {fix.column};"
        )


# ---------------------------------------------------------------------------
# 连接：URL -> 方言适配器
# ---------------------------------------------------------------------------

_PG_URL_RE = re.compile(
    r"^(?P<scheme>[^:/+]+)(?:\+(?P<driver>[^:/]+))?://"
    r"(?P<user>[^:@/]+)(?::(?P<password>[^@/]*))?@"
    r"(?P<host>[^:/@]+)(?::(?P<port>\d+))?/(?P<dbname>.+)$"
)


def _redact(url: str) -> str:
    """输出用：抹掉 URL 里的密码。"""
    return re.sub(r"(://[^:/@]+):[^@]*@", r"\1:***@", url)


def _describe(url: str) -> str:
    """输出用：库的可读标识（不含密码）。"""
    normalized = normalize_database_url(url)
    path = sqlite_database_path(normalized)
    if path is not None:
        return f"sqlite://{path}"
    return _redact(normalized)


def _open_dialect(url: str) -> Dialect:
    """按 URL 选择方言适配器。"""
    normalized = normalize_database_url(url)

    path = sqlite_database_path(normalized)
    if path is not None:
        if not path.exists():
            raise SystemExit(f"[!] SQLite 库文件不存在：{path}")
        return SQLiteDialect(str(path))

    if re.match(r"^postgres(ql)?(\+[^:]+)?://", normalized):
        return PostgresDialect(_dsn_from_url(normalized))

    raise SystemExit(
        f"[!] 暂不支持的数据库：{_redact(normalized)}\n"
        f"    本脚本支持 postgresql://（含 postgresql+psycopg2://）与 sqlite:///。"
    )


def _dsn_from_url(url: str) -> dict[str, Any]:
    """把 ``postgresql+psycopg2://user:pw@host:port/db`` 拆成 psycopg2 连接参数。"""
    match = _PG_URL_RE.match(url)
    if match is None:
        raise SystemExit(f"[!] 无法解析 DATABASE_URL：{_redact(url)}")
    return {
        "host": match.group("host"),
        "port": int(match.group("port") or 5432),
        "user": unquote(match.group("user")),
        "password": unquote(match.group("password") or ""),
        "dbname": match.group("dbname"),
    }


# ---------------------------------------------------------------------------
# 计划构建：分三个阶段，避免表间/列间顺序耦合
# ---------------------------------------------------------------------------


def _touched_tables() -> list[str]:
    ordered: list[str] = []
    for fix in (*COLUMNS_TO_ADD, *COLUMNS_TO_DROP):
        if fix.table not in ordered:
            ordered.append(fix.table)
    return ordered


def _ownership_conflicts(cur: Any) -> list[tuple[str, int]]:
    """找出「被多个场景同时引用」的表 —— v3 是一表一场景，这类数据无法自动消解。

    v2 的 ``scenes.table_id`` 是**单值指针**，但反过来看：多个场景指向同一张表
    在 v2 里是完全合法的（没有任何约束禁止）。v3 改成 ``SceneTable.scene_id``
    的一表一归属后，这种数据就变成了必须人工决策的冲突。

    为什么不加 ``LIMIT 1`` 糊过去：那会让两个库行为分叉且都错 ——
    PostgreSQL 的标量子查询遇多行直接报 ``more than one row returned``（整个
    修复事务 ROLLBACK，用户只看到一句难懂的 PG 报错）；SQLite 则**静默取第一
    行**，武断决定归属、然后愉快的删掉 ``table_id``，归属永久错且无任何提示。
    两种都不可接受，所以规划期就查出来拦住。

    返回 ``[(table_id, 引用它的场景数)]``，空列表表示无冲突。
    """
    rows = _safe_fetchall(
        cur,
        "SELECT t.id, count(DISTINCT s.id) AS n "
        "FROM scenes s JOIN scene_tables t ON t.id = s.table_id "
        "GROUP BY t.id HAVING count(DISTINCT s.id) > 1 "
        "ORDER BY t.id",
    )
    if not rows:
        return []
    return [(str(table_id), int(count)) for table_id, count in rows]


def _backfill_statements(
    dialect: Dialect,
    cur: Any,
    rows_by_table: dict[str, int],
    missing: dict[str, set[str]],
    plan: Plan,
) -> list[Statement]:
    """阶段 2：语义回填。只在确实有存量行时生成语句。

    ``missing`` 记录「规划时还不存在、但阶段 1 会补上」的列。这很重要：
    回填的目标列现在还不存在，直接拿它做 WHERE 过滤会查不出东西（PG 里还会
    把事务打成 aborted）。但补列时这些列的取值是确定的 —— 新建列一律落在模型
    默认值上（``scene_id=''`` / ``module_key=''`` / ``columns_signature=''``，
    ``scene_type`` 落在 ``'table_match'``），所以「列缺失」等价于「所有存量行
    都需要回填」。

    顺序有依赖：必须先有 ``scenes.scene_type``，才能按它算 ``module_key``；
    必须先有 ``scene_tables.scene_id``，才能写归属。
    """
    statements: list[Statement] = []

    # ---- 2a. 归属回填：scenes.table_id -> scene_tables.scene_id ----
    if rows_by_table.get("scenes", 0) > 0:
        conflicts = _ownership_conflicts(cur)
        if conflicts:
            # 冲突时既不回填也不删列 —— 删列依赖回填正确，回填依赖归属唯一。
            # 把 conclusion 交给 plan.blocked，由 main() 统一拒绝执行。
            detail = "；".join(
                f"表 {table_id} 被 {count} 个场景同时引用" for table_id, count in conflicts
            )
            plan.blocked.append(
                f"归属冲突：{detail}。\n"
                f"      原因：v2 的 scenes.table_id 是单值指针，多个场景指向同一张表"
                f"在 v2 里合法；v3 改成一表一场景（SceneTable.scene_id），"
                f"这种数据无法自动判定归属。\n"
                f"      后果：若强行回填，PostgreSQL 会因标量子查询返回多行而整体失败，"
                f"SQLite 会静默取第一行并删掉 table_id，归属被武断决定且无提示。\n"
                f"      请先人工决定这些表归属哪个场景（改 scenes.table_id 或直接写 "
                f"scene_tables.scene_id），再重跑本脚本。"
            )
        else:
            pending = _pending_ownership(
                cur, scene_id_missing="scene_id" in missing.get("scene_tables", set())
            )
            if pending:
                statements.append(
                    Statement(
                        "UPDATE scene_tables SET scene_id = ("
                        "SELECT s.id FROM scenes s WHERE s.table_id = scene_tables.id"
                        ") WHERE scene_id = '' AND EXISTS ("
                        "SELECT 1 FROM scenes s WHERE s.table_id = scene_tables.id);",
                        note=(
                            f"归属回填：{pending} 张表按 scenes.table_id 转成 v3 的 "
                            f"scene_tables.scene_id（否则删列会永久丢失归属）"
                        ),
                    )
                )

    # ---- 2b. scenes.module_key 语义回填：default_module_key(scene_type) ----
    if rows_by_table.get("scenes", 0) > 0:
        statements.extend(
            _module_key_backfill(
                dialect,
                cur,
                module_key_missing="module_key" in missing.get("scenes", set()),
                scene_type_missing="scene_type" in missing.get("scenes", set()),
            )
        )

    # ---- 2c. scene_tables.columns_signature 语义回填 ----
    if rows_by_table.get("scene_tables", 0) > 0:
        statements.extend(
            _signature_backfill(
                dialect,
                cur,
                columns_signature_missing="columns_signature" in missing.get("scene_tables", set()),
                report=plan.reports.get("scene_tables"),
            )
        )

    return statements


def _pending_ownership(cur: Any, scene_id_missing: bool) -> int:
    """还有多少张表「被某个场景引用、但 scene_id 尚未写成该场景」。

    ``scene_id`` 列还不存在时，补列后会全部落在空串，所以待办数就是「被场景
    引用的表总数」—— 用不依赖 scene_id 的查询算。
    """
    if scene_id_missing:
        sql = "SELECT count(*) FROM scenes s JOIN scene_tables t ON t.id = s.table_id"
    else:
        sql = (
            "SELECT count(*) FROM scenes s JOIN scene_tables t ON t.id = s.table_id "
            "WHERE t.scene_id = ''"
        )
    return _safe_scalar(cur, sql) or 0


def _module_key_backfill(
    dialect: Dialect,
    cur: Any,
    module_key_missing: bool,
    scene_type_missing: bool,
) -> list[Statement]:
    """按 ``scene_type`` 给空的 ``module_key`` 补默认 module。

    **数据驱动**：先查「还有哪些行需要回填」，没有就**不生成语句** —— 这是幂等
    的关键（否则第二遍仍会吐出 no-op 的 UPDATE，看起来像没修干净）。

    列还不存在时无法直接查它，此时按「补列后全部落在模型默认值」推导：
    - ``scene_type`` 缺失 → 补完都是 ``table_match``；
    - ``module_key`` 缺失 → 补完都是空串，即所有行都要回填。
    """
    mapping = _module_key_by_scene_type()

    if scene_type_missing:
        # 补列后全部是模型默认值 table_match，再加一个「未知类型」兜底分支
        pairs = [
            (scene_type, key) for scene_type, key in mapping.items() if scene_type == "table_match"
        ]
        unknown_fallback = mapping["table_match"]
    else:
        rows = _safe_fetchall(
            cur,
            "SELECT DISTINCT scene_type FROM scenes WHERE module_key IS NULL OR module_key = ''"
            if not module_key_missing
            else "SELECT DISTINCT scene_type FROM scenes",
        )
        if not rows:
            return []
        scene_types = [str(row[0] or "") for row in rows]
        pairs = [
            (scene_type, mapping.get(scene_type, mapping["table_match"]))
            for scene_type in scene_types
        ]
        unknown_fallback = None

    statements: list[Statement] = []
    for scene_type, module_key in pairs:
        statements.append(
            Statement(
                f"UPDATE scenes SET module_key = {dialect.placeholder} "
                f"WHERE (module_key IS NULL OR module_key = '') "
                f"AND scene_type = {dialect.placeholder};",
                (module_key, scene_type),
                note=(
                    f"module_key 回填（scene_type={scene_type} → {module_key}）："
                    f"空串会让 runtime 判定「场景未装配」并拒绝执行"
                ),
            )
        )

    if unknown_fallback is not None:
        placeholders = ", ".join(dialect.placeholder for _ in pairs) or "''"
        params: tuple[Any, ...] = (
            (unknown_fallback, *[scene_type for scene_type, _ in pairs])
            if pairs
            else (unknown_fallback,)
        )
        statements.append(
            Statement(
                f"UPDATE scenes SET module_key = {dialect.placeholder} "
                f"WHERE (module_key IS NULL OR module_key = '') "
                f"AND scene_type NOT IN ({placeholders});",
                params,
                note="module_key 兜底回填（未知 scene_type 按 default_module_key 的回落规则）",
            )
        )
    return statements


def _signature_backfill(
    dialect: Dialect,
    cur: Any,
    columns_signature_missing: bool,
    report: TableReport | None = None,
) -> list[Statement]:
    """按 ``columns_json`` 重算 ``columns_signature``。

    同样是**数据驱动**：列已存在时只查空值行，没有就不生成语句（幂等）；
    列缺失时补完都是空串，所以所有行都要回填。只读 ``id`` / ``columns_json``，
    因此在补列前跑也不会碰到不存在的列。

    ``columns_json`` 不可解析的行**一条语句都不生成**（只在报告里记一笔）。
    为什么不写空串：``columns_signature = ''`` 也是「未回填」的判定条件，写了
    空串下次运行还会被查出来、再写一次空串 —— 永远吐 no-op UPDATE，脚本看起来
    永远「没修干净」。而不写，第二遍就是真的 0 条语句。
    这些行本来也不缺值：补列时它们已经落在默认值 ``''`` 上了，写不写等价。
    """
    sql = "SELECT id, columns_json FROM scene_tables"
    if not columns_signature_missing:
        sql += " WHERE columns_signature IS NULL OR columns_signature = ''"
    rows = _safe_fetchall(cur, sql)
    if not rows:
        return []

    statements: list[Statement] = []
    unresolvable: list[str] = []
    for table_id, columns_json in rows:
        signature = _columns_signature_of(columns_json)
        if signature is None:
            unresolvable.append(str(table_id))
            continue
        statements.append(
            Statement(
                f"UPDATE scene_tables SET columns_signature = {dialect.placeholder} "
                f"WHERE id = {dialect.placeholder};",
                (signature, table_id),
                note=f"{table_id} 按 columns_json 重算列结构指纹",
            )
        )

    if unresolvable and report is not None:
        report.skipped.append(
            f"{len(unresolvable)} 张表的 columns_json 不可解析"
            f"（{', '.join(unresolvable)}），columns_signature 保持空串不变 —— "
            f"这些表下次上传时需重新判定同构，本脚本不猜"
        )
    return statements


def build_plan(dialect: Dialect, cur: Any, tables: dict[str, Table]) -> Plan:
    """读库现状，产出分阶段的 DDL 计划 + 每张表的修复前后对照。

    三个阶段，顺序不可交换：
    1. **补列** —— 先让列存在（回填与索引都依赖它）；
    2. **回填** —— 写语义值（依赖阶段 1 建好的列）；
    3. **删列** —— 删遗留列（依赖阶段 2 的归属回填已完成）。
    """
    plan = Plan()
    db_tables = dialect.tables(cur)

    rows_by_table: dict[str, int] = {}
    missing_by_table: dict[str, set[str]] = {}
    for table_name in _touched_tables():
        report = TableReport(table=table_name)
        plan.reports[table_name] = report

        if table_name not in db_tables:
            report.skipped.append("表不存在 —— 由 init_db 的 create_all 负责建表，跳过")
            continue
        table = tables.get(table_name)
        if table is None:
            report.skipped.append("模型里没有这张表，跳过")
            continue

        columns = dialect.columns(cur, table_name)
        report.cols_before = len(columns)
        report.rows = dialect.row_count(cur, table_name)
        rows_by_table[table_name] = report.rows
        missing_by_table.setdefault(table_name, set()).update(
            fix.column
            for fix in COLUMNS_TO_ADD
            if fix.table == table_name and fix.column not in columns
        )
        existing_indexes = dialect.indexes(cur, table_name)

        # ---- 阶段 1：补列 + 索引 ----
        for fix in COLUMNS_TO_ADD:
            if fix.table != table_name or fix.column in columns:
                continue  # 幂等：列已存在则整条跳过
            statements, skip_reason = dialect.add_column(table, fix.column, report.rows)
            if skip_reason:
                report.skipped.append(skip_reason)
                plan.blocked.append(f"{table_name}.{fix.column}: {skip_reason}")
                continue
            for statement in statements:
                if not statement.note:
                    statement.note = fix.reason
                plan.statements.append(statement)
            report.added.append(fix.column)

            index_statement = dialect.create_index(table, fix.column, existing_indexes)
            if index_statement is not None:
                index_statement.note = f"{fix.column} 的模型索引"
                plan.statements.append(index_statement)
                index_name = _model_index_name(table, fix.column) or (
                    f"ix_{table.name}_{fix.column}"
                )
                report.indexes.append(index_name)
                existing_indexes.add(index_name)

        # Indexes may also be missing while the column already exists (e.g. a
        # previous partial run added the column but not its index).
        for fix in COLUMNS_TO_ADD:
            if fix.table != table_name or fix.column not in columns:
                continue
            index_statement = dialect.create_index(table, fix.column, existing_indexes)
            if index_statement is not None:
                index_statement.note = f"{fix.column} 的模型索引（列已在位，索引缺失）"
                plan.statements.append(index_statement)
                index_name = _model_index_name(table, fix.column) or (
                    f"ix_{table.name}_{fix.column}"
                )
                report.indexes.append(index_name)
                existing_indexes.add(index_name)

    # ---- 阶段 2：语义回填 ----
    backfills = _backfill_statements(dialect, cur, rows_by_table, missing_by_table, plan)
    plan.statements.extend(backfills)
    if backfills:
        for table_name in ("scene_tables", "scenes"):
            if table_name in plan.reports:
                plan.reports[table_name].backfilled.append(
                    f"{len(backfills)} 条回填语句（见下方明细）"
                )

    # ---- 阶段 3：删遗留列 ----
    # 回填被阻塞（归属冲突）时**不生成删列语句**：删列依赖归属已正确迁移，
    # 否则删掉 table_id 就永久失去了判定归属的唯一依据。
    # 注意这里不 early-return —— 下面还要算 cols_after 供输出用。
    drops_blocked = bool(plan.blocked)
    for table_name in _touched_tables():
        report = plan.reports[table_name]
        if drops_blocked and any(fix.table == table_name for fix in COLUMNS_TO_DROP):
            report.skipped.append(
                "删列已跳过 —— 回填阶段被阻塞，先解决阻塞项再重跑（不删则归属依据仍在，可安全重试）"
            )
            continue
        if table_name not in db_tables or tables.get(table_name) is None:
            continue
        table = tables[table_name]
        columns = dialect.columns(cur, table_name)
        for fix in COLUMNS_TO_DROP:
            if fix.table != table_name:
                continue
            for statement in dialect.drop_column(cur, fix, table, columns, report.rows, report):
                plan.statements.append(statement)
                if "DROP COLUMN" in statement.sql:
                    report.dropped.append(fix.column)

    for report in plan.reports.values():
        report.cols_after = report.cols_before + len(report.added) - len(report.dropped)

    return plan


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def print_plan(plan: Plan, mode: str, target: str, dialect: Dialect) -> None:
    print(f"目标库：{target}   方言：{dialect.label}   模式：{mode}")
    print("=" * 78)
    for table_name, report in plan.reports.items():
        print(f"\n[{table_name}]  行数={report.rows}")
        print(f"  列数：{report.cols_before} → {report.cols_after}")
        if report.added:
            print(f"  补列：{', '.join(report.added)}")
        if report.dropped:
            print(f"  删列：{', '.join(report.dropped)}")
        if report.indexes:
            print(f"  补索引：{', '.join(report.indexes)}")
        for reason in report.skipped:
            print(f"  [跳过] {reason}")

    print("\n" + "=" * 78)
    if not plan.statements:
        print("无需执行任何 DDL —— 库已是目标 schema（幂等：重复执行安全）。")
        return

    print(f"待执行语句 {len(plan.statements)} 条：\n")
    for index, statement in enumerate(plan.statements, start=1):
        print(f"  {index:2d}. {statement.sql}")
        if statement.note:
            print(f"      -- {statement.note}")

    if plan.blocked:
        print("\n[!] 以下项目被阻塞，需要人工先决定语义：")
        for item in plan.blocked:
            print(f"    - {item}")


def _baseline_columns() -> dict[str, set[str]]:
    """v2 时代这几张表的列基线 —— 用来区分「模型新增的列」与「库里本来就有的列」。

    ``--source-check`` 要在**不连库**的前提下判断「清单是否漏了一条」，就必须
    知道哪些列是 model-only（v3 新增）、哪些是库本来就有的。这份基线取自线上
    PG 旧库的 ``information_schema`` 实测结果（2026-11 快照），也就是「任何
    v2 库都一定有的列」。维护方式：这几张表再加列时，新列会自动落进「模型有、
    基线没有、清单也没覆盖」的漏项里被报出来 —— 这正是我们想要的行为。
    """
    return {
        "harness_task_frames": {
            "id",
            "tenant_id",
            "session_id",
            "source_turn_id",
            "task_id",
            "agent_loop_id",
            "kind",
            "decision",
            "status",
            "sequence",
            "skill_id",
            "step_id",
            "user_intent",
            "requirements_json",
            "slots_json",
            "depends_on_json",
            "task_requirement_json",
            "result_json",
            "error_json",
            "state_version",
            "attempt_no",
            "lease_owner",
            "lease_expires_at",
            "created_at",
            "updated_at",
        },
        "scene_runs": {
            "id",
            "tenant_id",
            "scene_id",
            "session_id",
            "user_id",
            "input_json",
            "result_json",
            "trace_json",
            "status",
            "feedback",
            "created_at",
        },
        "scene_tables": {
            "id",
            "tenant_id",
            "name",
            "source_filename",
            "source_document_id",
            "columns_json",
            "quality_json",
            "row_count",
            "status",
            "created_at",
            "updated_at",
        },
        "scenes": {
            "id",
            "tenant_id",
            "name",
            "description",
            "icon",
            "status",
            "table_id",
            "trigger_json",
            "slots_json",
            "match_action_json",
            "respond_action_json",
            "shortcut_json",
            "created_at",
            "updated_at",
        },
    }


def print_source_check(tables: dict[str, Table]) -> int:
    """``--source-check``：双向校验修复清单与模型（不连库）。

    两个方向都要查，因为它们犯的是不同的错：

    - **清单 → 模型**（单向，原本就有）：清单里写了个模型已经没有的列。
      通常发生在「模型改了列名但忘了改脚本」，报错很直观。
    - **模型 → 清单**（反向，本函数新增）：模型有、清单没覆盖的列。
      这才是最危险的一类 —— **清单漏项不会让脚本报错，只会让它少修一列**，
      于是库修完仍然缺列，用户启动照样崩。这类漂移只有双向校验能发现。
    """
    problems: list[str] = []
    print("修复清单 vs 模型 校验（不连库）")
    print("=" * 78)

    add_by_table: dict[str, set[str]] = {}
    for fix in COLUMNS_TO_ADD:
        add_by_table.setdefault(fix.table, set()).add(fix.column)
    drop_by_table: dict[str, set[str]] = {}
    for fix in COLUMNS_TO_DROP:
        drop_by_table.setdefault(fix.table, set()).add(fix.column)

    # ---- 方向 1：清单里的条目在模型里是否存在 / 是否该存在 ----
    for fix in COLUMNS_TO_ADD:
        table = tables.get(fix.table)
        if table is None:
            problems.append(f"{fix.table} 不在模型里（要补列的表已改名或删除？）")
            continue
        if table.columns.get(fix.column) is None:
            problems.append(f"{fix.table}.{fix.column} 模型里不存在（要补的列已改名？）")

    for fix in COLUMNS_TO_DROP:
        table = tables.get(fix.table)
        if table is None:
            problems.append(f"{fix.table} 不在模型里（要删列的表已改名或删除？）")
            continue
        if table.columns.get(fix.column) is not None:
            problems.append(f"{fix.table}.{fix.column} 模型里仍存在（要删的列又加回来了？）")

    # ---- 方向 2：模型里 model-only 的列是否都被清单覆盖 ----
    baseline = _baseline_columns()
    skipped_tables: list[str] = []
    for table_name in sorted(baseline):
        table = tables.get(table_name)
        if table is None:
            problems.append(f"{table_name} 在基线里但模型里没有（整表被改名或删除？）")
            continue
        model_columns = {column.name for column in table.columns}
        model_only = model_columns - baseline[table_name]
        covered = add_by_table.get(table_name, set())
        uncovered = sorted(model_only - covered)
        if uncovered:
            problems.append(
                f"{table_name}: 模型比 v2 基线多出 {sorted(model_only)}，"
                f"但修复清单只覆盖 {sorted(covered)} —— "
                f"漏项 {uncovered}（漏一列就会导致库修完仍缺列）"
            )
        # 反向：清单里声明要补的列，若在基线里已存在，说明基线写错了或清单冗余
        redundant = sorted(covered & baseline[table_name])
        if redundant:
            problems.append(
                f"{table_name}: 清单要补 {redundant}，但它们在 v2 基线里已存在 —— "
                f"要么基线过时，要么清单多写"
            )
        skipped_tables.append(table_name)

    if problems:
        print("[!] 发现不一致，请先修脚本的修复清单：")
        for problem in problems:
            print(f"    - {problem}")
        return 1

    total_model_only = sum(
        len({column.name for column in tables[name].columns} - baseline[name]) for name in baseline
    )
    print(
        f"通过（双向）：{len(COLUMNS_TO_ADD)} 个待补列 / {len(COLUMNS_TO_DROP)} 个待删列"
        f"与模型一致；{len(skipped_tables)} 张表的 {total_model_only} 个 model-only 列"
        f"已全部被清单覆盖，无漏项。"
    )
    return 0


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------


def _safe_rollback(connection: Any) -> None:
    """尽力回滚，失败也不抛 —— 用于「已经在处理另一个错误」的收尾路径。

    连接已经坏掉时 ``rollback()`` 自身也会抛（psycopg2 的 ``InterfaceError``、
    sqlite3 的 ``ProgrammingError``）。在错误处理里再抛一个错会盖掉原始原因，
    所以这里只记录不抛。
    """
    try:
        connection.rollback()
    except Exception as exc:  # noqa: BLE001 - 见 docstring：故意吞掉
        print(f"    （回滚时连接已失效，忽略：{type(exc).__name__}: {exc}）")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="一次性补齐场景 v3 在已有库中缺失的列与索引（create_all 不补列）"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--apply", action="store_true", help="真正执行并提交（缺省 dry-run）")
    group.add_argument(
        "--verify",
        action="store_true",
        help="在事务内实跑全部 DDL 后 ROLLBACK，用于验证语句能被目标库接受",
    )
    group.add_argument(
        "--source-check",
        action="store_true",
        help="只校验脚本的修复清单与模型是否一致（不连库）",
    )
    parser.add_argument(
        "--database-url",
        default=None,
        help="覆盖 DATABASE_URL（便于对本地 SQLite 库或临时副本先试跑）",
    )
    args = parser.parse_args()

    tables = _load_tables()

    if args.source_check:
        return print_source_check(tables)

    url = args.database_url or get_settings().database_url
    dialect = _open_dialect(url)
    target = _describe(url)
    mode = "APPLY" if args.apply else ("VERIFY（跑完 ROLLBACK）" if args.verify else "DRY-RUN")

    try:
        connection = dialect.connect()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - 连接失败要中文提示，不要 traceback
        print(f"[!] 连接数据库失败（{dialect.label}）：{exc}")
        return 1

    try:
        cur = connection.cursor()
        try:
            plan = build_plan(dialect, cur, tables)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 - 规划阶段也要兜住
            # 规划阶段的意外（库内部损坏、sqlite_master 可读但某张表页损坏、
            # 模型与库结构以意想不到的方式不兼容……）如果直接抛，用户看到的是
            # traceback。这里统一转成「没做任何事」的干净退出。
            #
            # 注意此时**还没有执行任何 DDL**，所以不需要 ROLLBACK 补救 ——
            # 但只读探测也可能留下开启的事务，显式回滚一次更干净。
            print(f"\n[!] 规划修复计划时出错，未执行任何 DDL：{exc}")
            print(f"    类型：{type(exc).__name__}")
            print("    如需排查，可加 --verify 单独复跑；库本身未被修改。")
            _safe_rollback(connection)
            return 1
        finally:
            # 计划构建只读；结束它自己的隐式事务，后续执行从干净状态开始
            _safe_rollback(connection)

        print_plan(plan, mode, target, dialect)

        if plan.blocked:
            print("\n[!] 计划被阻塞，未执行任何语句。")
            return 1
        if not plan.statements:
            return 0
        if not (args.apply or args.verify):
            print("\n（dry-run 未写库；确认无误后加 --apply 执行，或加 --verify 先试跑）")
            return 0

        # ---- 单事务执行全部语句 ----
        print(f"\n{'=' * 78}\n开始执行 {len(plan.statements)} 条语句（单一事务）...")
        try:
            cur.execute("BEGIN")
            executed = 0
            for index, statement in enumerate(plan.statements, start=1):
                # 不可逆语句的执行瞬间复检（防规划期到执行期之间的并发写入）
                if statement.require_verified is not None:
                    violations = dialect.guard_count(cur, statement.require_verified)
                    if violations:
                        connection.rollback()
                        print(
                            f"\n[!] 第 {index} 条前复检失败，已整体 ROLLBACK："
                            f"守卫报告 {violations} 个违例行，拒绝执行不可逆 DDL。"
                        )
                        print(f"    语句：{statement.sql}")
                        return 1
                cur.execute(statement.sql, statement.params or ())
                executed += 1
            print(f"  {executed} 条语句全部执行成功。")

            print("\n修复后复核：")
            clean = dialect.verdict(cur, tables)

            if args.apply:
                if not clean:
                    connection.rollback()
                    print("\n[!] 复核未通过，已 ROLLBACK，库里无任何改动。")
                    return 1
                cur.execute("COMMIT")
                print("\n已 COMMIT。")
            else:
                connection.rollback()
                print("\n[--verify] 已显式 ROLLBACK —— DDL 语法与执行全部通过，库里无任何改动。")
            return 0 if clean else 1
        except SystemExit:
            connection.rollback()
            raise
        except Exception as exc:  # noqa: BLE001 - 统一回滚并报告
            connection.rollback()
            print(f"\n[!] 执行失败，已整体 ROLLBACK：{exc}")
            return 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
