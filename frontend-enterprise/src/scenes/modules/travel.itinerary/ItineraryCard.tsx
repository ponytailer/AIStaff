import { SceneEmptyCard } from '../../shared/SceneEmptyCard';
import type { SceneBlockProps } from '../../types';
import {
  itineraryDays,
  itineraryHeader,
  itineraryMeta,
  primaryHit,
  priceNote,
  priceText,
  subtitleText,
  type ItineraryDay,
} from './itineraryData';

/**
 * `travel.itinerary` 的结果卡。
 *
 * **所有数值逐值照抄 `scene-v3-visual-contract.md` §1**。为什么不用 `text-xs` /
 * `text-sm`：那些依赖主题字号，项目改一次全局字号整张卡就漂；这里一律写
 * `text-[11.5px]` 这种字面值。
 *
 * 最容易做错的四个点（contract §7.1 清单）：
 * 1. 卡头渐变方向 `135deg`（左上→右下），不是 `90deg` / `to bottom`；
 * 2. 日期徽标 `size-[34px] shrink-0` —— 改文案不能让徽标变形（否则整条竖线歪）；
 * 3. 最后一日连接线**不显示**，用 `{!isLast && <线>}` 判断，不靠 CSS 兜；
 * 4. 价格 `¥3,000` 有千分位（`toLocaleString('zh-CN')`），不是 `¥3000`。
 */

/** contract §1.1 外框：圆角 14 / 1px `--border` / 白底 / `--elev-card` / 裁切。 */
const CARD_CLASS =
  'overflow-hidden rounded-[14px] border border-[#ded7cc] bg-white '
  + 'shadow-[0_1px_2px_rgba(17,17,17,0.04),0_1px_8px_rgba(70,76,94,0.06)]';

/** 元信息条里的一项（key 10px / value 12.5px mono 600）。 */
function MetaItem({
  label,
  value,
  tone,
  alignRight = false,
}: {
  label: string;
  value: string;
  /** `success` → `#138a55`；`warning` → `#b45309`（contract §1.3）。 */
  tone?: 'success' | 'warning';
  alignRight?: boolean;
}) {
  if (!value) return null;
  const color = tone === 'success'
    ? 'text-[#138a55]'
    : tone === 'warning'
      ? 'text-[#b45309]'
      : 'text-[#18181a]';
  return (
    <div className={`flex flex-col gap-[1px] ${alignRight ? 'ml-auto text-right' : ''}`}>
      <span className="text-[10px] tracking-[0.02em] text-[#9a9b95]">{label}</span>
      <span className={`text-[12.5px] font-semibold font-mono ${color}`}>{value}</span>
    </div>
  );
}

/**
 * 一天。
 *
 * `isLast` 控制连接线 —— 用 JS 判断，不用 CSS `:last-child`：
 * CSS 方案在「最后一行之上又插入了别的元素」这类改动静默失效，JS 判断不会。
 */
function DayRow({ day, isLast }: { day: ItineraryDay; isLast: boolean }) {
  return (
    <div className="flex gap-[11px] pb-[14px] last:pb-0">
      {/* 左侧轨道：固定 40px，徽标 34px 居中。尺寸必须固定（见文件头 ②）。 */}
      <div className="flex w-[40px] shrink-0 flex-col items-center">
        <div className="flex size-[34px] flex-col items-center justify-center rounded-[10px] bg-[#e1f1ed] text-[8.5px] leading-[1.1] font-semibold text-[#0f766e]">
          <b className="font-mono text-[13px] leading-none">{day.indexLabel}</b>
          {/* 活动类型：P0 没有日程字段时是空串 —— 留空但徽标尺寸不变。 */}
          <span>{day.phase}</span>
        </div>
        {!isLast && <div className="mt-[4px] w-[1.5px] flex-1 bg-[#e7dfd3]" />}
      </div>
      <div className="min-w-0 flex-1 pt-[2px]">
        {day.title ? (
          <p className="mb-[3px] text-[12px] font-semibold text-[#18181a]">{day.title}</p>
        ) : null}
        {day.description ? (
          <p className="m-0 text-[11.5px] leading-[1.6] text-[#343633]">{day.description}</p>
        ) : null}
        {day.tags.length > 0 && (
          <div className="mt-[5px] flex flex-wrap gap-[5px]">
            {day.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-[4px] bg-[#eeece4] px-[5px] py-[1px] text-[10px] text-[#343633]"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 收下整份 `SceneBlockProps` 但只解构 `block` / `params`：
 * 卡上没有任何可点元素了（按钮已移除，见价格条注释），
 * `sendText` / `disabled` 在这张卡里无处可施。签名仍与 `ResultCard` 契约一致。
 */
export function ItineraryResultCard({ block, params }: SceneBlockProps) {
  const hit = primaryHit(block);
  const header = itineraryHeader(hit, params);
  const subtitle = subtitleText(header, params);
  const meta = itineraryMeta(hit, params);
  const days = itineraryDays(hit, params);
  const price = priceText(hit, params);
  const note = priceNote(params);

  // 没有命中行的 result 块（后端有时会把空结果也塞成 result）：不画空卡，
  // 退化成一段文本，不去抢 EmptyState 的语义。
  if (!hit.row_id && Object.keys(hit.values).length === 0) {
    return (
      <div className={CARD_CLASS}>
        <div className="px-[14px] py-[11px] text-[12px] leading-[1.6] text-[#343633]">
          {block.fallback_text || '这条行程没有可展示的数据。'}
        </div>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS} data-scene-module="travel.itinerary">
      {/* 卡头：渐变 135deg（左上→右下）。写 90deg 会变成左右渐变，一眼能看出差。 */}
      <div className="border-b border-[#e7dfd3] bg-[linear-gradient(135deg,#f0faf8_0%,#fbfbfa_100%)] px-[14px] py-[11px]">
        {header.title ? (
          <h3 className="mb-[2px] text-[13px] font-semibold tracking-[-0.01em] text-[#18181a]">
            {header.title}
          </h3>
        ) : null}
        {subtitle ? <div className="text-[11.5px] text-[#9a9b95]">{subtitle}</div> : null}
      </div>

      {/* 元信息条：最后一项「匹配度」ml-auto 右对齐（contract §1.3）。 */}
      <div className="flex gap-[14px] border-b border-[#e7dfd3] bg-[#fbfaf6] px-[14px] py-[9px]">
        <MetaItem label="人数" value={meta.people} />
        <MetaItem label="天数" value={meta.days} />
        {/* demo 里「预算」的值是绿的（表示预算吻合），跟随匹配度色调更诚实：
            匹配度「有偏差」时预算也标橙，用户不会误以为预算对上了。 */}
        <MetaItem label="预算" value={meta.budget} tone={meta.match.tone} />
        <MetaItem label="匹配度" value={meta.match.text} tone={meta.match.tone} alignRight />
      </div>

      {/* 逐日时间轴 */}
      {days.length > 0 && (
        <div className="flex flex-col px-[14px] py-[12px]">
          {days.map((day, index) => (
            <DayRow key={day.indexLabel} day={day} isLast={index === days.length - 1} />
          ))}
        </div>
      )}

      {/*
        价格条**只有价格和说明**，没有操作按钮。

        这里刻意不放「选这个 / 看详情」：
        - 「选这个」发出去的是「就选经典雪山五日」，而行程推荐本身就是终态 ——
          用户看完卡就决定了，再让他点一次「选这个」只是把同一句话复述一遍；
        - 「看详情」在 P0 只是 `sendText('看看经典雪山五日的详情')`，不发请求
          也不开弹窗（见 `itineraryData.detailText` 注释），点了等于白转一圈
          再回一张一样的卡。

        代价是价格条在窄容器下会显得空。这是诚实的空 —— 比挂两颗点了没反应的
        按钮强。真要放开，请等「点选 → 锁单」这条链路做出来（P1-4 的回执状态）
        再说，那时按钮才有真实语义。

        结构上仍保留「价格 → 说明（可省略）→ 右侧留白」，`min-w-0` 还在：
        说明文字过长时仍然单行省略，不会把价格条撑成两行。
      */}
      <div className="flex items-center gap-[10px] border-t border-[#e7dfd3] bg-[#fbfaf6] px-[14px] py-[11px]">
        {price ? (
          <span className="shrink-0 font-mono text-[15px] font-semibold text-[#18181a]">{price}</span>
        ) : null}
        {note ? (
          // 单行省略：价格条在契约里恒为一行。窄容器（超管预览栏 304px）下
          // 若允许折行，这段说明会折 3 行把条撑到 70px，与聊天里 520px 宽的
          // 真实观感差得太远 —— 预览就失去参考价值了。全文挂在 title 上。
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#9a9b95]" title={note}>
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** 空结果：与所有 generic module 共用同一张卡（contract §2 逐值实现在 shared 里）。 */
export function ItineraryEmptyState({ block, sendText, submitSlots, canSubmitSlots, disabled = false }: SceneBlockProps) {
  return (
    <SceneEmptyCard
      block={block}
      title="没有找到符合条件的行程"
      sendText={sendText}
      // 建议按钮要能「改槽重跑」：带上提交能力，按钮才会走确定性
      // 改槽路径而不是发一句自然语言（后者会落回普通对话）。
      submitSlots={submitSlots}
      canSubmitSlots={canSubmitSlots}
      disabled={disabled}
      dataModule="travel.itinerary.empty"
    />
  );
}