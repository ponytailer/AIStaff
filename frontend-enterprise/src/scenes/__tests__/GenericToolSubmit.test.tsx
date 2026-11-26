// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SceneBlockList from '../SceneBlockList';
import type { SceneUiBlock } from '../types';

/**
 * `generic.tool_submit` —— 「收表单 → 调接口 → 回执」的界面层。
 *
 * 数据取自 `backend/tests/test_scene_tool_submit.py` 的 `DELIVERY_RESPONSE`
 * （客房送物），并**刻意保留后端已经剔掉的协议字段**吗？不 —— 这里用的是
 * 后端**真实下发**的形态：`_receipt_values` 已经去掉 `accepted` / `status` /
 * `message`，只剩业务字段 + `labels`。
 *
 * 这条边界很重要：如果测试用的是接口原始 JSON，那么「后端剔协议字段」这件事
 * 就永远测不到它在前端的效果 —— 两边各自测各自的过滤，合起来仍然可能漏。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * 后端 `_run_tool_submit` 的成功产物（2026-11-26 实跑快照）。
 *
 * `labels` 来自场景 `slots_json` 的 label，是块级字段而非塞进 `values` ——
 * `values` 只放业务数据，混进显示名前端就分不清「这是字段」还是「这是别人的名字」。
 */
function receiptBlock(): SceneUiBlock {
  return {
    kind: 'result',
    module_key: 'generic.tool_submit',
    module_version: 1,
    fallback_text: '已为 8306 房提交矿泉水，受理单号 RD20261126BB6，预计 20 分钟内送达。',
    data: {
      total: 1,
      max_items: 1,
      labels: { room_no: '房间号', item: '物品', quantity: '数量', guest_name: '住客姓名' },
      items: [
        {
          row_id: 'receipt',
          source_table: '',
          values: {
            order_no: 'RD20261126BB6',
            room_no: '8306',
            item: '矿泉水',
            quantity: 2,
            eta_minutes: 20,
            guest_name: '张先生',
          },
        },
      ],
    },
  };
}

/** 后端 `_slot_form_block()` 的输出（缺必填槽位时才有）。 */
function formBlock(): SceneUiBlock {
  return {
    kind: 'form',
    module_key: 'generic.tool_submit',
    module_version: 1,
    fallback_text: '请补充信息后继续。',
    data: {
      kind: 'slot_form',
      title: '客房送物 · 请填写',
      submit_label: '提交',
      fields: [
        {
          name: 'item',
          label: '需要送的物品',
          type: 'text',
          required: true,
          placeholder: '例如 矿泉水、毛巾、牙刷',
        },
      ],
    },
  };
}

/** 后端失败态：`on_empty: "none"` + 空 suggestions。 */
function failureBlock(): SceneUiBlock {
  return {
    kind: 'empty',
    module_key: 'generic.tool_submit',
    module_version: 1,
    fallback_text: '接口暂时不可用，请稍后再试或联系工作人员。',
    data: {
      reason: '接口暂时不可用，请稍后再试或联系工作人员。',
      suggestions: [],
      on_empty: 'none',
    },
  };
}

describe('generic.tool_submit 回执卡', () => {
  it('单号单独一行且用配置的标签（它是用户回查的唯一凭据）', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} params={{ receipt_no_label: '受理单号' }} />);

    expect(await screen.findByText('RD20261126BB6')).toBeTruthy();
    expect(screen.getByText('受理单号')).toBeTruthy();
    // 单号不应该在下面的扁平字段里再出现一次（重复显示会让人以为有两个号）。
    expect(screen.getAllByText('RD20261126BB6')).toHaveLength(1);
  });

  it('没配 receipt_no_label 时退回「单号」', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} />);
    expect(await screen.findByText('单号')).toBeTruthy();
  });

  it('卡头用配置的 receipt_title，副标题提示保留单号', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} params={{ receipt_title: '客房送物已提交' }} />);
    expect(await screen.findByText('客房送物已提交')).toBeTruthy();
    expect(screen.getByText('请保留下面的单号，便于后续查询')).toBeTruthy();
  });

  it('没配 receipt_title 时退回默认「已提交」', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} />);
    expect(await screen.findByText('已提交')).toBeTruthy();
  });

  it('字段名用 labels 里的中文名，而不是英文 key（否则就是一坨 JSON）', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} />);

    // 中文名出现
    expect(await screen.findByText(/房间号/)).toBeTruthy();
    expect(screen.getByText(/物品/)).toBeTruthy();
    expect(screen.getByText(/数量/)).toBeTruthy();
    // 英文 key 不该裸露（`room_no` / `item` / `quantity` 都是接口参数名）
    expect(screen.queryByText(/room_no/)).toBeNull();
    expect(screen.queryByText(/\bitem\b/)).toBeNull();
  });

  it('labels 里没有的字段退回显示原 key（能看出是哪个字段，比编个错名好）', async () => {
    render(<SceneBlockList blocks={[receiptBlock()]} />);
    // `eta_minutes` 是接口自己加的，槽位里没有对应项
    expect(await screen.findByText(/eta_minutes/)).toBeTruthy();
  });

  it('字段按「用户关心的先后」排，不跟接口 JSON 的键序', async () => {
    /*
      这条锁的是显示顺序。接口把 `eta_minutes` 放在倒数第几个位置是它的事，
      回执卡该按「房号 → 物品 → 数量 → 多久到 → 谁 → 备注」排 ——
      「多久能到」是用户扫一眼回执最想确认的东西，掉到第二行就白排了。
    */
    const block = receiptBlock();
    block.data = {
      ...block.data,
      // 给 `eta_minutes` 配中文名 —— 否则它会渲染成英文 key，
      // `at('预计送达(分钟)')` 就找不到（这条用例想测的是顺序，不是 naming）
      labels: {
        ...((block.data?.labels ?? {}) as Record<string, string>),
        eta_minutes: '预计送达(分钟)',
      },
      items: [
        {
          row_id: 'receipt',
          source_table: '',
          // 刻意把 eta_minutes 放在最后，模拟一个「字段顺序不友好」的接口
          values: {
            order_no: 'RD1',
            note: '放门口',
            guest_name: '张先生',
            eta_minutes: 20,
            quantity: 2,
            item: '矿泉水',
            room_no: '8306',
          },
        },
      ],
    };
    const { container } = render(<SceneBlockList blocks={[block]} />);
    await screen.findByText('RD1');

    // 每个字段渲染成 `<span>{label} <span>{value}</span></span>`，
    // 所以外层 span 的 textContent 是「房间号 8306」这种。取整串的
    // **起始下标**比较顺序，避免去匹配带尾随空格的单段文本。
    const flat = Array.from(container.querySelectorAll('span'))
      .map((el) => el.textContent ?? '')
      .filter((text) => text.includes(' '));   // 只留「字段名 值」这种外层
    const at = (name: string) => flat.findIndex((text) => text.startsWith(`${name} `));

    const order = ['房间号', '物品', '数量', '预计送达(分钟)'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    // 严格递增：房号 → 物品 → 数量 → 多久到
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('协议字段不画进卡片（accepted / status / message 都该被后端剔掉）', async () => {
    // 这条是「后端剔了 + 前端不补」的合起来验证。前端若自己造一份兜底
    // 「缺字段就显示原样 JSON」，这里会红。
    render(<SceneBlockList blocks={[receiptBlock()]} />);
    await screen.findByText('RD20261126BB6');
    expect(screen.queryByText(/accepted/)).toBeNull();
    expect(screen.queryByText(/status/)).toBeNull();
    // `message` 那句话已经在正文（text）里说过了，卡片里不该再说一遍
    expect(screen.queryByText(/已受理，客房部会在/)).toBeNull();
  });

  it('没有「查看进度」按钮（2026-11-26 移除：点了没有实际作用）', async () => {
    /*
      这颗按钮原先做的是 `sendText('帮我查一下刚才那单的进度')` —— 起一轮普通
      对话，让模型自己理解「刚才那单」。但模型手上没有这张回执的上下文：单号
      只在卡片里，不在会话槽位，也没有对应的查单工具。于是它只能回「请提供
      单号」或者编一段进度。

      用户原话：「移除查看进度的按钮，因为点了也没啥实际的作用。」

      这条断言锁住「别顺手加回来」—— 真要加，得先有「按单号查」的工具接口。
      `onSendText` 仍然传：它若被这颗按钮偷偷调用，`expect` 会 catch 到。
    */
    const onSend = vi.fn();
    render(<SceneBlockList blocks={[receiptBlock()]} onSendText={onSend} />);
    await screen.findByText('RD20261126BB6');

    expect(screen.queryByRole('button', { name: /进度/ })).toBeNull();
    // 配置里塞旧的 `progress_text` 也不该复活它 —— 参数项已删除，
    // 残留数据（老场景的 ui_config.params）不能把它带回来。
    expect(onSend).not.toHaveBeenCalled();
  });

  it('老的 progress_text 配置不会让按钮复活（存量数据兜底）', async () => {
    /*
      已有场景的 `ui_config.params` 里可能还留着 `progress_text`。渲染代码
      删了，所以它应该是**惰性数据**：既不渲染按钮，也不报错。
      若将来有人「为了兼容」把它读回来，这条会红。
    */
    render(
      <SceneBlockList
        blocks={[receiptBlock()]}
        params={{ progress_text: '查看进度', progress_query: '查一下' }}
      />,
    );
    await screen.findByText('RD20261126BB6');

    expect(screen.queryByRole('button', { name: '查看进度' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查运单' })).toBeNull();
  });

  it('没有「再来一单」这类按钮（提交类场景的终态是「办完了」）', async () => {
    /*
      刻意不加，不是漏做：再点一次大概率是重复下单。
      这条断言锁住「别顺手加回来」—— 真要加，请先由业务方明确要求。
    */
    render(<SceneBlockList blocks={[receiptBlock()]} />);
    await screen.findByText('RD20261126BB6');
    expect(screen.queryByRole('button', { name: /再来一单/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /重新提交/ })).toBeNull();
  });

  it('没有单号时副标题改成「已处理 N 项」，不硬编一个「请保留单号」', async () => {
    const block = receiptBlock();
    block.data = {
      ...block.data,
      items: [{ row_id: 'receipt', source_table: '', values: { item: '矿泉水' } }],
    };
    render(<SceneBlockList blocks={[block]} />);

    expect(await screen.findByText('已处理 1 项')).toBeTruthy();
    expect(screen.queryByText('请保留下面的单号，便于后续查询')).toBeNull();
  });

  it('items 为空或坏数据时退化成兜底文本，不白屏也不装作办完了', async () => {
    const block = receiptBlock();
    block.data = { ...block.data, total: 0, items: [] };
    render(<SceneBlockList blocks={[block]} />);

    expect(await screen.findByText(/已为 8306 房提交矿泉水/)).toBeTruthy();
  });

  it('labels 是坏数据（数组 / 非对象）时不崩，退回原 key', async () => {
    const block = receiptBlock();
    block.data = { ...block.data, labels: ['房间号', '物品'] as unknown as Record<string, string> };
    render(<SceneBlockList blocks={[block]} />);

    expect(await screen.findByText(/room_no/)).toBeTruthy();
  });
});

describe('generic.tool_submit 话术全部可配（样式固定、话术开放）', () => {
  /*
    这一组锁的是「**说什么话**归员工，长什么样归代码」。

    版式（渐变卡头、单号一行、字段平铺）用户改不了也不该改 —— 那是视觉契约；
    但同一句「提交成功」，客房送物说「师傅会上门」，报修说「已派单给张师傅」，
    预约说「凭码到前台取号」。写死一句只能对上一个业务。
  */

  it('副标题可以自己写，不用系统的「请保留单号」', async () => {
    render(
      <SceneBlockList
        blocks={[receiptBlock()]}
        params={{ receipt_subtitle: '师傅会在 20 分钟内送到房间' }}
      />,
    );

    expect(await screen.findByText('师傅会在 20 分钟内送到房间')).toBeTruthy();
    expect(screen.queryByText('请保留下面的单号，便于后续查询')).toBeNull();
  });

  it('单号字段可以显式指定 —— 接口用 waybill_no 也认得出', async () => {
    /*
      这是「去硬编码」的核心用例。原先只枚举 order_no / ticket_id /
      receipt_id / booking_no / appointment_no 五个字段名，接口改成
      `waybill_no` 就一个都命中不了，而单号是用户报查的唯一凭据。
    */
    const block = receiptBlock();
    block.data = {
      ...block.data,
      labels: { waybill_no: '运单号', room_no: '房间号' },
      items: [
        {
          row_id: 'receipt',
          source_table: '',
          values: { waybill_no: 'SF7788990011', room_no: '8306' },
        },
      ],
    };
    render(
      <SceneBlockList
        blocks={[block]}
        params={{ receipt_no_field: 'waybill_no', receipt_no_label: '运单号' }}
      />,
    );

    expect(await screen.findByText('SF7788990011')).toBeTruthy();
    expect(screen.getByText('运单号')).toBeTruthy();
  });

  it('不指定字段时按词根猜 —— case_no / serial / 中文「单号」都命中', async () => {
    const block = receiptBlock();
    block.data = {
      ...block.data,
      labels: { case_no: '工单编号' },
      items: [{ row_id: 'receipt', source_table: '', values: { case_no: 'WO-2026-001', item: '空调维修' } }],
    };
    render(<SceneBlockList blocks={[block]} />);

    // case_no 含 `no` 词根 → 识别为单号，并单独成行
    expect(await screen.findByText('WO-2026-001')).toBeTruthy();
    expect(screen.getByText('工单编号')).toBeTruthy();
  });

  it('「像单号但其实不是」的字段不会被误认（quantity / paid / valid）', async () => {
    /*
      这些 key 含 `id` 或 `no` 但显然不是单号。把「数量」标成「单号」
      比不显示单号更糟 —— 用户会拿数量去报查。
    */
    const block = receiptBlock();
    block.data = {
      ...block.data,
      labels: { quantity: '数量' },
      items: [
        { row_id: 'receipt', source_table: '', values: { quantity: 2, paid: true, item: '矿泉水' } },
      ],
    };
    render(<SceneBlockList blocks={[block]} />);

    // 没有单号 → 副标题走「已处理 N 项」这条分支
    expect(await screen.findByText('已处理 1 项')).toBeTruthy();
    // 数量仍然作为普通字段显示
    expect(screen.getByText('数量')).toBeTruthy();
  });
});

describe('generic.tool_submit 表单与失败态', () => {
  it('form 块复用平台槽位表单（renderForm），不自己画一套', async () => {
    // 场景表单与 SOP 表单必须同一个组件，否则校验/提交口径会分裂成两套。
    render(
      <SceneBlockList
        blocks={[formBlock()]}
        renderForm={(data) => <span data-testid="platform-form">{String(data.title)}</span>}
      />,
    );
    expect(await screen.findByTestId('platform-form')).toBeTruthy();
    expect(screen.getByTestId('platform-form').textContent).toBe('客房送物 · 请填写');
  });

  it('renderForm 缺失时退回兜底文本，不抛异常（分享页 / 单测场景）', async () => {
    render(<SceneBlockList blocks={[formBlock()]} />);
    expect(await screen.findByText('请补充信息后继续。')).toBeTruthy();
  });

  it('失败态 on_empty=none 时建议区整块消失（放宽条件对接口故障没用）', async () => {
    // 这是与 table_match 的关键差异：那边空结果要建议「换个条件」，
    // 这边失败原因是外部接口 —— 给「放宽条件」只会把用户引向错误动作。
    render(<SceneBlockList blocks={[failureBlock()]} />);

    expect(await screen.findByText(/接口暂时不可用/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '放宽条件再找一次' })).toBeNull();
    expect(screen.queryByRole('button', { name: '看看最接近的几条' })).toBeNull();
  });
});