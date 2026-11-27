import { useEffect, useRef } from 'react';

import { animate } from 'animejs';

/**
 * 在岗人员的头像方阵：取产品里真实存在的岗位首字，不是占位文案。
 * tone 对应下方 AVATAR_TONE 的配色档位。
 */
const ON_DUTY = [
  { mark: '市', tone: 0 },
  { mark: '数', tone: 1 },
  { mark: '采', tone: 2 },
  { mark: '+3', tone: 3 },
] as const;

/** 头像底色：淡紫系四档，深浅交替，叠排时不会糊成一块。 */
const AVATAR_TONE = [
  'bg-[linear-gradient(140deg,#a78bfa,#7c3aed)]',
  'bg-[linear-gradient(140deg,#c084fc,#9333ea)]',
  'bg-[linear-gradient(140deg,#818cf8,#4f46e5)]',
  'bg-[linear-gradient(140deg,#a5b4fc,#7c3aed)]',
] as const;

/** 指标卡的 7 根柱子，高度用百分比写死，避免依赖随机数导致每次渲染跳动。 */
const BAR_HEIGHTS = [42, 64, 50, 82, 60, 94, 72] as const;

/**
 * 登录页左栏的场景拼贴（Bento）。
 *
 * 结构照 Mystique 品牌稿：圆角面板 + 窄缝、宽窄混排。
 * 节奏靠「一块竖跨两行的高面板」撑起来 —— 没有竖向元素，四块面板怎么排
 * 都只是一摞横条（这一版之前试过 2×2 等分与"横幅+一行两块"两种排法，
 * 都因为缺竖向结构而显得像表格）。
 *
 *   紫渐变横幅 4/6  ┬ 深紫竖卡 2/6（跨两行）
 *   亮色界面卡 2/6  │
 *   指标卡     2/6  ┘
 *
 * 配色是淡色版：整页浅底，只有这块竖卡用饱和紫作唯一的重色锚点，
 * 其余面板都是白底或极浅紫 —— 这样页面整体是淡的，又不会淡到没有重点。
 *
 * 面板内容对应真实场景（谁在岗 / 任务执行示意 / 交付量），不是装饰图形。
 */
export default function LoginSceneCollage() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // 柱状图轻微呼吸：让「这里在跑数据」有迹可循。
    // 只动 transform / opacity，不碰 height —— 动高度会逐帧触发布局。
    const bars = Array.from(root.querySelectorAll<HTMLElement>('[data-sc-bar]'));
    const anims = bars.map((bar, index) =>
      animate(bar, {
        scaleY: [0.74, 1],
        opacity: [0.75, 1],
        duration: 2400 + index * 130,
        delay: index * 150,
        ease: 'inOutSine',
        loop: true,
        alternate: true,
      }),
    );

    return () => {
      for (let i = anims.length - 1; i >= 0; i -= 1) anims[i].revert();
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="mt-[30px] grid w-full grid-cols-6 grid-rows-[118px_118px] gap-[10px] text-left max-[640px]:grid-cols-2 max-[640px]:grid-rows-[auto_auto_auto]"
    >
      {/* ① 紫渐变横幅：视觉锚点 + 谁在岗 */}
      <div
        className="col-span-4 row-span-1 flex flex-col justify-center gap-[7px] rounded-[15px] px-[22px] shadow-[0_14px_34px_-20px_rgba(124,58,237,0.55)] max-[640px]:col-span-2 max-[640px]:px-[16px] max-[640px]:py-[13px]"
        style={{
          background:
            'radial-gradient(120% 170% at 8% -30%, rgba(196,181,253,0.95), transparent 58%), linear-gradient(112deg, #f1e9ff 0%, #e7dcfb 52%, #ddd0f7 100%)',
          border: '1px solid rgba(124,58,237,0.14)',
        }}
      >
        <span className="text-[16px] font-semibold leading-[1.35] tracking-[-0.012em] text-[#3b2f5e]">
          把一次交代，变成一套可复用的流程
        </span>
        <span className="max-w-[320px] text-[12px] leading-[1.55] text-[#6b6288]">
          它记得上次停在哪、你在意什么，下次直接接着办
        </span>
        <div className="mt-[3px] flex flex-wrap items-center gap-x-[9px] gap-y-[6px]">
          <div className="flex items-center" aria-hidden>
            {ON_DUTY.map((item) => (
              <span
                key={item.mark}
                className={`-ml-[6px] grid size-[21px] shrink-0 place-items-center rounded-[6px] text-[9px] font-semibold text-white first:ml-0 ${AVATAR_TONE[item.tone]}`}
                style={{ boxShadow: '0 0 0 1.5px #f0eafd' }}
              >
                {item.mark}
              </span>
            ))}
          </div>
          <span className="text-[11.5px] leading-none text-[#6b6288]">
            <b className="font-semibold text-[#3b2f5e]">4 位</b>处理中 · 2 位待命
          </span>
        </div>
      </div>

      {/* ② 竖跨两行的深紫卡：整个拼贴唯一的饱和色块，撑住竖向节奏。
          窄屏没有竖向空间可撑，转成一条通栏的品牌带：slogan 单行、
          「经验·流程·判断」靠右不换行，否则三段文字会互相挤压折行。 */}
      <div
        className="col-span-2 row-span-2 flex flex-col justify-between overflow-hidden rounded-[15px] px-4 py-[15px] shadow-[0_16px_36px_-18px_rgba(109,40,217,0.65)] max-[640px]:col-span-2 max-[640px]:row-span-1 max-[640px]:min-h-[74px] max-[640px]:flex-row max-[640px]:items-center max-[640px]:justify-start max-[640px]:gap-[12px] max-[640px]:px-[16px] max-[640px]:py-[13px]"
        style={{
          background:
            'radial-gradient(110% 70% at 80% 108%, rgba(167,139,250,0.5), transparent 60%), linear-gradient(168deg, #7c3aed 0%, #6d28d9 55%, #5b21b6 100%)',
        }}
      >
        <span className="shrink-0 text-[10px] font-semibold uppercase leading-none tracking-[0.16em] text-[#d8cbff]">
          AIStaff
        </span>
        <p className="m-0 min-w-0 flex-1 text-[16px] font-semibold leading-[1.38] tracking-[-0.015em] text-white max-[640px]:text-[14.5px]">
          Intelligence.
          <br className="max-[640px]:hidden" />{' '}
          On duty.
        </p>
        <span className="shrink-0 whitespace-nowrap text-[10px] uppercase leading-none tracking-[0.1em] text-[#c4b0f5] max-[640px]:hidden">
          经验 · 流程 · 判断
        </span>
      </div>

      {/* ③ 亮色界面卡：任务执行示意，证明「真的有人在用」 */}
      <div className="col-span-2 row-span-1 flex flex-col gap-[6px] rounded-[15px] border border-[rgba(124,58,237,0.13)] bg-white px-[13px] py-[11px] shadow-[0_10px_26px_-18px_rgba(46,42,61,0.4)] max-[640px]:col-span-1">
        <div className="flex items-center gap-[5px]">
          <i className="size-[5px] rounded-full bg-[#7c3aed]" />
          <i className="size-[5px] rounded-full bg-[#ddd6fe]" />
          <i className="size-[5px] rounded-full bg-[#ddd6fe]" />
          <span className="ml-[3px] text-[9.5px] font-semibold uppercase tracking-[0.06em] text-[#8b82a3]">
            行程推荐
          </span>
        </div>
        <div className="flex min-h-[16px] items-center gap-[7px]">
          <i className="size-[14px] shrink-0 rounded-[4.5px] bg-[linear-gradient(140deg,#a78bfa,#7c3aed)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <i className="h-[5px] w-[70%] rounded-full bg-[#ddd6fe]" />
            <i className="h-[5px] w-[38%] rounded-full bg-[#ddd6fe]" />
          </span>
        </div>
        <div className="flex min-h-[16px] items-center gap-[7px]">
          <i className="size-[14px] shrink-0 rounded-[4.5px] bg-[linear-gradient(140deg,#c084fc,#9333ea)]" />
          <span className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <i className="h-[5px] w-[84%] rounded-full bg-[#c4b5fd]" />
            <i className="h-[5px] w-[52%] rounded-full bg-[#c4b5fd]" />
          </span>
        </div>
        <span className="mt-[1px] flex w-fit items-center gap-[5px] rounded-[5px] border border-[rgba(16,185,129,0.28)] bg-[rgba(16,185,129,0.10)] px-[6px] text-[9px] font-semibold leading-[16px] text-[#0d7a52]">
          <svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path
              d="M2 6.2 4.6 8.8 10 3.2"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          已交付 3 条方案
        </span>
      </div>

      {/* ④ 指标卡：一块数字，给拼贴收尾 */}
      <div className="col-span-2 row-span-1 flex flex-col justify-center gap-[3px] rounded-[15px] border border-[rgba(124,58,237,0.13)] bg-[linear-gradient(158deg,#fbfaff,#f4f0fe)] px-[14px] py-[12px] max-[640px]:col-span-1 max-[640px]:min-h-[118px]">
        <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-[#8b82a3]">
          本周已交付
        </span>
        <span className="flex items-baseline gap-[5px] text-[21px] font-semibold leading-[1.15] tracking-[-0.02em] text-[#2e2a3d]">
          128
          <small className="text-[10.5px] font-medium tracking-normal text-[#7c7392]">件</small>
          <span className="flex items-center gap-[3px] text-[9.5px] font-semibold text-[#138a55]">
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none" aria-hidden>
              <path
                d="M2.4 8.4 6 4.2l3.6 4.2"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            23%
          </span>
        </span>
        <div className="mt-[2px] flex h-[22px] items-end gap-[3px]" aria-hidden>
          {BAR_HEIGHTS.map((height, index) => (
            <i
              key={index}
              data-sc-bar
              className="min-w-0 flex-1 origin-bottom rounded-[2px_2px_1px_1px] bg-[linear-gradient(180deg,#a78bfa,#7c3aed)]"
              style={{ height: `${height}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}