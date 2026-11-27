import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { animate, createAnimatable, createTimeline, stagger, utils } from 'animejs';

export type LoginCardStackProps = {
  /** 前排卡片的内容：真实的登录表单。 */
  children: ReactNode;
};

/**
 * 后排界面卡的静态错位参数。位移/旋转/缩放写在外层定位壳上（不参与动画），
 * 漂浮与入场动画只作用于内层，避免两套 transform 互相覆盖。
 */
const BACK_CARDS = [
  { x: -178, y: -86, rotate: -5, scale: 0.92, bars: ['w-[60%]', 'w-[80%]', 'w-[40%]'], tone: 'violet' },
  { x: 180, y: -72, rotate: 4, scale: 0.95, bars: ['w-[80%]', 'w-[60%]', 'w-[80%]'], tone: 'lilac' },
  { x: 8, y: 96, rotate: -1.5, scale: 1, bars: ['w-[40%]', 'w-[80%]', 'w-[60%]'], tone: 'plain' },
] as const;

const TONE_CLASS: Record<string, string> = {
  violet: 'bg-[rgba(124,58,237,0.10)] text-[#7c3aed]',
  lilac: 'bg-[rgba(168,85,247,0.12)] text-[#9333ea]',
  plain: 'bg-[#f1eefc] text-[#8b82a3]',
};

/** 卡片骨架条的公共样式。 */
const BAR_CLASS = 'h-[9px] rounded-[5px] bg-[#eeeafa]';

function hiddenState(scale: number): CSSProperties {
  return { opacity: 0, transform: `scale(${scale})` };
}

/**
 * 登录框的「视差浮层卡片堆」：
 *
 *   scene    —— 透视容器，承接指针事件
 *   depth    —— 后排整层压到 z 轴 -60px：无论怎么转，深度上永远压不过前排表单
 *   tilt     —— 指针视差：只转后排装饰卡（createAnimatable 平滑跟随）
 *   shell    —— 每张卡的静态错位（位移 + 旋转 + 缩放，内联 transform，不参与动画）
 *   float    —— 漂浮：每张装饰卡以不同周期缓慢上下呼吸
 *
 * 后排三张是产品界面示意卡（骨架条 + 能力片），前排是真实登录表单。
 *
 * 表单卡是交互面，必须钉死：不随指针转、也不漂浮。
 * 原来整堆一起转 + 前排自己上下浮，指针移到输入栏上时整个表单在光标底下晃，
 * 悬停目标（输入框描边、I-beam 光标）反复翻转，看起来就是「鼠标乱窜」。
 */
export default function LoginCardStack({ children }: LoginCardStackProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const backRefs = useRef<Array<HTMLDivElement | null>>([]);
  const frontRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scene = sceneRef.current;
    const tilt = tiltRef.current;
    const front = frontRef.current;
    const backs = backRefs.current.filter(Boolean) as HTMLDivElement[];
    if (!scene || !tilt || !front) return;

    const allCards = [...backs, front];

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      utils.set(allCards, { opacity: 1, scale: 1 });
      return;
    }

    // 入场：后排依次浮出，前排表单最后落位
    const intro = createTimeline({ defaults: { duration: 720, ease: 'outQuint' } });
    intro
      .add(backs, { opacity: [0, 1], scale: [0.7, 1], duration: 640, delay: stagger(110), ease: 'outBack' }, 0)
      .add(front, { opacity: [0, 1], scale: [0.82, 1], duration: 780, ease: 'outBack' }, 320);

    // 漂浮：每张装饰卡不同周期、不同相位，画面不「死」也不「晃」。
    // 只浮后排：前排表单是交互面，浮起来会让悬停目标在光标底下漂。
    const floats = backs.map((card, index) =>
      animate(card, {
        y: [0, index % 2 ? -11 : 11],
        duration: 2600 + index * 520,
        delay: 1500,
        ease: 'inOutSine',
        loop: true,
        alternate: true,
      }),
    );

    // 指针视差：精细指针设备才启用，触屏不做。
    //
    // 这里原来每收到一次 pointermove 就 getBoundingClientRect()：那是一次强制同步布局，
    // 而此刻页面上还有十几条 anime.js 常驻动画在跑，读一次矩形就要把整页重排一遍，
    // 鼠标一动帧率就掉到个位数。改成：
    //   · 矩形在 pointerenter / 滚动 / 改窗口时才量，移动过程中直接复用；
    //   · 事件只记坐标，真正的写入合并到下一帧（一帧最多一次）。
    let tiltAnimation: ReturnType<typeof createAnimatable> | null = null;
    let bounds: DOMRect | null = null;
    let pendingX = 0;
    let pendingY = 0;
    let frameId = 0;

    const measure = () => {
      bounds = scene.getBoundingClientRect();
    };

    const applyTilt = () => {
      frameId = 0;
      if (!tiltAnimation || !bounds || !bounds.width || !bounds.height) return;
      const px = (pendingX - bounds.left) / bounds.width - 0.5;
      const py = (pendingY - bounds.top) / bounds.height - 0.5;
      tiltAnimation.rotateY(px * 7);
      tiltAnimation.rotateX(-py * 4.5);
    };

    const onPointerMove = (event: PointerEvent) => {
      pendingX = event.clientX;
      pendingY = event.clientY;
      if (!frameId) frameId = requestAnimationFrame(applyTilt);
    };
    const onPointerEnter = () => {
      measure();
    };
    const onPointerLeave = () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
      tiltAnimation?.rotateX(0);
      tiltAnimation?.rotateY(0);
    };

    if (window.matchMedia('(pointer: fine)').matches) {
      tiltAnimation = createAnimatable(tilt, { rotateX: 500, rotateY: 500, ease: 'out(2)' });
      scene.addEventListener('pointerenter', onPointerEnter);
      scene.addEventListener('pointermove', onPointerMove);
      scene.addEventListener('pointerleave', onPointerLeave);
      window.addEventListener('scroll', measure, { passive: true });
      window.addEventListener('resize', measure);
    }

    return () => {
      intro.revert();
      floats.forEach((item) => item.revert());
      if (frameId) cancelAnimationFrame(frameId);
      scene.removeEventListener('pointerenter', onPointerEnter);
      scene.removeEventListener('pointermove', onPointerMove);
      scene.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      tiltAnimation?.revert();
    };
  }, []);

  return (
    <div ref={sceneRef} className="relative flex w-full justify-center py-[10px] [perspective:1200px]">
      {/* 场景固定 560px 宽，但双栏时右栏只有 396px：两侧装饰卡的横向偏移
          会伸出栏外。1440 下正好落在两栏右侧的页边距里，窄一点就直接越过
          视口，被 overflow-x-clip 切掉。
          --sx 必须是纯数字（数字混长度的 clamp 会让整条 transform 失效，
          三张卡会叠成一摞）。只在「双栏且不够宽」的那一段收紧横向偏移：
          1440 有 130px 页边距，够用；1280 起只有 50px，要收到 0.44。
          x 偏移参与缩放，y 不参与——竖向本来就在版心内。 */}
      <div
        className="relative h-[352px] w-[min(560px,94vw)] [transform-style:preserve-3d] [--sx:1] max-[1439px]:min-[1151px]:[--sx:0.44] max-[900px]:h-[276px]"
      >
        {/* 后排装饰卡：整层先压到 -60px 深度，再由 tilt 整层随指针微转。
            分层是为了让表单卡彻底退出 3D 旋转——装饰怎么动都抢不到表单的
            悬停目标，指针在输入栏上时表单纹丝不动。 */}
        <div aria-hidden className="absolute inset-0 [transform:translateZ(-60px)] [transform-style:preserve-3d]">
          <div ref={tiltRef} className="absolute inset-0 [transform-style:preserve-3d] [will-change:transform]">
            {BACK_CARDS.map((card, index) => (
              <div
                key={card.tone}
                className={`absolute left-1/2 top-1/2 ${index < 2 ? 'max-[900px]:hidden' : 'max-[560px]:hidden'}`}
                style={{
                  transform: `translate(-50%, -50%) translate(calc(${card.x}px * var(--sx)), ${card.y}px) rotate(${card.rotate}deg) scale(${card.scale})`,
                }}
              >
                <div
                  ref={(el) => {
                    backRefs.current[index] = el;
                  }}
                  style={hiddenState(1)}
                  className="w-[290px] rounded-[16px] border border-[rgba(124,58,237,0.10)] bg-white p-[18px] shadow-[0_20px_50px_rgba(91,33,182,0.10)] [will-change:transform]"
                >
                  {card.bars.map((bar, barIndex) => (
                    <div key={barIndex} className={`${BAR_CLASS} ${bar} ${barIndex > 0 ? 'mt-[10px]' : ''}`} />
                  ))}
                  <div className="mt-[16px] flex gap-[8px]">
                    <span className={`rounded-[7px] px-[10px] py-[3px] text-[11px] ${TONE_CLASS[card.tone]}`}>
                      数字员工
                    </span>
                    <span className="rounded-[7px] bg-[#f1eefc] px-[10px] py-[3px] text-[11px] text-[#8b82a3]">
                      执行记录
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 前排表单卡：交互面，不参与视差与漂浮 */}
        <div className="absolute left-1/2 top-1/2 z-10" style={{ transform: 'translate(-50%, -50%)' }}>
          <div
            ref={frontRef}
            style={hiddenState(1)}
            className="w-[326px] rounded-[18px] border border-[rgba(124,58,237,0.13)] bg-white p-[22px] shadow-[0_28px_70px_rgba(76,29,149,0.14)] [will-change:transform]"
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
