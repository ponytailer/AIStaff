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
 * 竖卡里的 SOP 步骤。三态对应三种圈：勾选 / 实心 / 空心。
 * 底部文案「进行到 3 / 4 步」与进度条宽度都依赖这份顺序，改的时候一起改。
 */
const SOP_STEPS = [
  { label: '澄清采购需求', state: 'done' },
  { label: '汇总供应商清单', state: 'done' },
  { label: '供应商比价分析', state: 'active' },
  { label: '生成审批材料', state: 'todo' },
] as const;

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

      {/* ② 竖跨两行的 SOP 执行卡：把「数字员工正在干活」讲成一条可读的流程。
          SOP_STEPS 的 done / active / todo 三态对应勾选、实心点、空心圈，
          进度条按已完成步数算，和底部文案的「3 / 4 步」保持一致 —— 改步数时
          这三处要一起改，否则卡片自己会前后矛盾。 */}
      <div className="col-span-2 row-span-2 flex flex-col rounded-[15px] border border-[rgba(124,58,237,0.13)] bg-white px-[15px] py-[14px] shadow-[0_16px_36px_-20px_rgba(91,33,182,0.30)] max-[640px]:col-span-2 max-[640px]:row-span-1">
        <div className="flex items-center gap-[6px]">
          <i className="size-[6px] shrink-0 rounded-full bg-[#7c3aed]" />
          <span className="text-[10px] font-semibold tracking-[0.02em] text-[#5f5872]">项目任务</span>
          <span className="text-[10px] text-[#a79fbb]">·</span>
          <span className="text-[10px] font-medium text-[#8b5cf6]">执行中</span>
        </div>

        <span className="mt-[7px] text-[13.5px] font-semibold leading-[1.4] tracking-[-0.01em] text-[#2e2a3d]">
          供应商比价与审批材料
        </span>

        <ol className="m-0 mt-[9px] flex list-none flex-col gap-[6px] p-0">
          {SOP_STEPS.map((step) => (
            <li key={step.label} className="flex items-center gap-[7px]">
              {step.state === 'done' && (
                <span className="grid size-[13px] shrink-0 place-items-center rounded-full border border-[rgba(124,58,237,0.45)] text-[#7c3aed]">
                  <svg width="7" height="7" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path d="M2 6.2 4.6 8.8 10 3.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              )}
              {step.state === 'active' && (
                <span className="grid size-[13px] shrink-0 place-items-center rounded-full border border-[#7c3aed]">
                  <i className="size-[6px] rounded-full bg-[#7c3aed]" />
                </span>
              )}
              {step.state === 'todo' && (
                <span className="size-[13px] shrink-0 rounded-full border border-[#ded8ec]" />
              )}
              <span
                className={
                  step.state === 'active'
                    ? 'truncate text-[11.5px] font-semibold leading-[1.3] text-[#2e2a3d]'
                    : step.state === 'done'
                      ? 'truncate text-[11.5px] leading-[1.3] text-[#6b6288]'
                      : 'truncate text-[11.5px] leading-[1.3] text-[#a79fbb]'
                }
              >
                {step.label}
                {step.state === 'active' && '...'}
              </span>
            </li>
          ))}
        </ol>

        {/* 进度：4 步里完成 3 步 → 75%，但当前这步还在跑，视觉上给 62%。
            纯装饰，所以直接写死宽度，不跟状态推导。 */}
        <div className="mt-[11px] h-[5px] w-full overflow-hidden rounded-full bg-[#efeaf9]" aria-hidden>
          <div className="h-full w-[62%] rounded-full bg-[linear-gradient(90deg,#a78bfa,#7c3aed)]" />
        </div>

        <span className="mt-[9px] text-[10px] leading-[1.3] text-[#8b82a3]">
          SOP · 采购流程 v2 · 进行到 3 / 4 步
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