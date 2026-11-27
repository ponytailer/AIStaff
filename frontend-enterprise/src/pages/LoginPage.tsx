import { useEffect, useRef, type CSSProperties } from 'react';

import { animate, createTimeline, stagger, text, utils } from 'animejs';

import LoginForm from '../components/LoginForm';
import AppHeader from '@/components/AppHeader';
import BrandLogo from '@/components/BrandLogo';
import LoginCardStack from '../components/LoginCardStack';
import LoginSceneCollage from '../components/LoginSceneCollage';
import LoginSopFlow from '../components/LoginSopFlow';
import type { EnterpriseAuthSession } from '../auth';

export type LoginPageProps = {
  onLogin: (session: EnterpriseAuthSession) => void;
};

/** 入场前先藏起来，避免首帧闪一下再跳到起点（useEffect 在首帧绘制后才跑）。 */
function hiddenFrom(offsetY: number): CSSProperties {
  return { opacity: 0, transform: `translateY(${offsetY}px)` };
}

/**
 * 未登录的落地 / 登录页。
 *
 * 版式（左叙事 / 右登录，淡色系）：
 *   品牌眼眉 → 产品主标题（按字入场）→ 副标题 → 场景拼贴 → 「视差浮层卡片堆」登录框
 *   → 底部「SOP 光路流水线」：一条光路穿过四个能力节点，光脉冲循环跑完全程。
 *
 * 左栏的场景拼贴（`LoginSceneCollage`）替代了原来的「在岗播报」单条轮播：
 * 播报一次只能露一条，而拼贴能同时说清「谁在岗 / 任务怎么跑 / 交付了多少」，
 * 也才有了 Mystique 那种品牌级拼贴的观感。
 *
 * 配色是淡色版：整页浅底（#fbfaff 系），运营色统一收敛到淡紫——
 * 只有场景拼贴里那块竖卡用饱和紫作唯一的重色锚点，其余全是白底 / 极浅紫。
 * 这样页面是「淡」的，但不会淡到没有重点。
 *
 * 性能约束（改这里之前先读一遍，实测 12fps 的教训）：
 *   1. 背景光斑不用 `filter: blur()`：模糊半径 70px 的层每帧都要重新栅格化，
 *      改用自身带柔边的 radial-gradient，transform 动画就只剩合成，不再重绘。
 *   2. 任何常驻动画都只允许动 transform / opacity，不动 letterSpacing、width、height。
 *   3. 表单状态在 LoginForm 内部：输入时这一层（连同卡片堆、拼贴、光路）一次都不重渲染，
 *      否则每敲一个字符就会打断一圈合成层。
 */
export default function LoginPage({ onLogin }: LoginPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const subtitleRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const page = pageRef.current;
    const brand = brandRef.current;
    const title = titleRef.current;
    const subtitle = subtitleRef.current;
    if (!page || !brand || !title || !subtitle) return;

    const auroraBlobs = Array.from(page.querySelectorAll<HTMLElement>('[data-aurora]'));
    const heroBlocks = [brand, subtitle];

    // 主标题按字入场。拆字依赖 ResizeObserver，jsdom 等环境没有它，
    // 那就退化成整行出现，不为了动画把页面渲染搞挂。
    const splitter = typeof ResizeObserver === 'undefined'
      ? null
      : text.splitText(title, { chars: true, words: false, lines: false });
    const titleParts: HTMLElement[] = splitter?.chars?.length
      ? (splitter.chars as HTMLElement[])
      : [title];

    const disposers: Array<() => void> = [];
    if (splitter) disposers.push(() => splitter.revert());
    const disposeAll = () => {
      for (let i = disposers.length - 1; i >= 0; i -= 1) disposers[i]();
    };

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      utils.set([...heroBlocks, title], { opacity: 1, y: 0, scale: 1 });
      return disposeAll;
    }

    // 背景光斑：十几秒一轮的缓慢漂移，让大面积留白「活」着。
    // 纯 transform（位移 + 缩放），元素本身没有 filter，所以帧内不重绘。
    auroraBlobs.forEach((blob, index) => {
      const drift = animate(blob, {
        x: [0, index % 2 ? -70 : 80],
        y: [0, index % 2 ? 50 : -60],
        scale: [1, index % 2 ? 1.18 : 0.9],
        duration: 11000 + index * 2600,
        ease: 'inOutSine',
        loop: true,
        alternate: true,
      });
      disposers.push(() => drift.revert());
    });

    // 主入场：眼眉 → 标题逐字 → 副标题（登录卡堆入场由 LoginCardStack 自理）
    // 原来还带一段 letterSpacing 0.62em → 0.2em 的收字距动画：那是逐帧布局，已删除，
    // 字距直接用静态值，视觉差异肉眼几乎看不出，帧时间省一半。
    const intro = createTimeline({ defaults: { duration: 720, ease: 'outQuint' } });
    intro
      .set(title, { opacity: 1 }, 0)
      .add(brand, { opacity: [0, 1], y: [14, 0] }, 0)
      .add(
        titleParts,
        { opacity: [0, 1], y: ['0.7em', '0em'], duration: 900, delay: stagger(30), ease: 'outExpo' },
        140,
      )
      .add(subtitle, { opacity: [0, 1], y: [16, 0] }, '-=540');
    disposers.push(() => intro.revert());

    return disposeAll;
  }, []);

  return (
    <div ref={pageRef} className="relative flex min-h-screen flex-col overflow-x-clip bg-[#fbfaff]">
      {/* 背景层：光斑 + 淡网格，纯装饰。
          光斑不加 filter: blur —— 柔边由 gradient 自己的多段色标提供，
          否则 70px 的模糊会跟着 transform 每帧重算，是原来卡顿的头号开销。 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          data-aurora
          className="absolute -left-[16%] top-[-6%] h-[520px] w-[660px] rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.30),rgba(167,139,250,0.07)_52%,transparent_76%)] [will-change:transform]"
        />
        <div
          data-aurora
          className="absolute -right-[14%] top-[10%] h-[560px] w-[640px] rounded-full bg-[radial-gradient(circle,rgba(196,181,253,0.34),rgba(196,181,253,0.07)_52%,transparent_76%)] [will-change:transform]"
        />
        <div
          data-aurora
          className="absolute left-[24%] top-[54%] h-[460px] w-[640px] rounded-full bg-[radial-gradient(circle,rgba(129,140,248,0.20),rgba(129,140,248,0.05)_54%,transparent_78%)] [will-change:transform]"
        />
        <div className="absolute inset-0 bg-[radial-gradient(rgba(124,58,237,0.055)_1px,transparent_1px)] [background-size:26px_26px] [mask-image:radial-gradient(ellipse_at_50%_36%,black,transparent_72%)]" />
      </div>

      <AppHeader
        className="relative z-10 h-[60px] shrink-0 px-[32px] pt-[10px]"
        left={<BrandLogo markSize={28} />}
        right={null}
      />

      <main className="relative z-10 flex flex-1 flex-col items-center px-[32px] pb-[10px]">
        <div className="grid w-full max-w-[1180px] grid-cols-[minmax(0,1fr)_396px] items-center gap-[64px] pt-[30px] text-left max-[1150px]:grid-cols-1 max-[1150px]:justify-items-center max-[1150px]:gap-[40px] max-[1150px]:pt-[16px] max-[1150px]:text-center">
          {/* 左：品牌叙事 + 场景拼贴 */}
          <section className="flex min-w-0 flex-col max-[1150px]:w-full max-[1150px]:items-center">
            {/* 两行做层级化排版：品牌名作眼眉（小号、宽字距、弱色）承接品牌，
                产品名作主标题。拆成两个 span 是为了让读屏把品牌名与产品名分开读，
                中间的空白文本节点不能省。 */}
            <h1 className="m-0 flex flex-col max-[1150px]:items-center">
              <span
                ref={brandRef}
                style={hiddenFrom(14)}
                className="mr-[-4px] text-[20px] font-medium leading-[30px] tracking-[4px] text-[#7c7392]"
              >
                AIStaff
              </span>
              {' '}
              <span
                ref={titleRef}
                style={{ opacity: 0 }}
                className="mt-[10px] text-[40px] font-semibold leading-[52px] tracking-[0.8px] text-[#2e2a3d] max-[720px]:text-[32px] max-[720px]:leading-[42px]"
              >
                AI 数字员工平台
              </span>
            </h1>

            <p
              ref={subtitleRef}
              style={hiddenFrom(16)}
              className="mt-[18px] max-w-[520px] text-[16px] leading-[26px] text-[#6b6288]"
            >
              把经验、流程与判断标准，沉淀成持续在岗的数字员工
            </p>

            <LoginSceneCollage />
          </section>

          {/* 右：登录卡堆。表单自己管状态，输入时这一层不重渲染。 */}
          <section className="flex w-full flex-col items-center">
            <LoginCardStack>
              <LoginForm onLogin={onLogin} />
            </LoginCardStack>
          </section>
        </div>

        {/* 底部：SOP 光路流水线 */}
        <LoginSopFlow />
      </main>
    </div>
  );
}