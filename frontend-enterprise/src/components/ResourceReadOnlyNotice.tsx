/**
 * 员工资源的「只读」提示条。
 *
 * 为什么需要它：员工档案下的知识库 / SOP / 技能 / 工具 / FAQ 都属于「装给这个员工的
 * 资产」，写权限归属于**员工创建人或租户管理员**。非 owner 进来时，那些写入口会被
 * 逐个隐藏 —— 但只隐藏按钮会让人以为页面坏了（"为什么没有新增"），所以每处都要有
 * 一句话说明"你能看，但不能改"。
 *
 * 统一收到这里而不是各页写一套：文案口径改一次就够，样式也不会各处长歪。
 */
export default function ResourceReadOnlyNotice({
  resource,
  className,
}: {
  /** 资源名，用于拼文案：「你可以查看这个员工的知识库，但不能修改」。 */
  resource: string;
  className?: string;
}) {
  return (
    <div
      role="note"
      className={[
        'flex items-start gap-[8px] rounded-[12px] border border-[#e6e4df] bg-[#f7f6f3] px-[14px] py-[11px]',
        className || 'mb-[16px]',
      ].join(' ')}
    >
      <span aria-hidden className="mt-[1px] shrink-0 text-[13px] leading-[1.6] text-[#9a9a9f]">
        ◇
      </span>
      <p className="m-0 min-w-0 text-[12.5px] leading-[1.7] text-[#6d6d72]">
        你可以查看这个员工的{resource}，但不能修改 —— 编辑权限属于该员工的创建人或租户管理员。
      </p>
    </div>
  );
}