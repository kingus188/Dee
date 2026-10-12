export function createTaskCenterLayout() {
  const toggle = document.createElement("button");
  toggle.id = "v3-toggle";
  toggle.textContent = "任务中心";
  toggle.setAttribute("aria-controls", "v3-drawer");
  toggle.setAttribute("aria-expanded", "false");
  const panel = document.createElement("aside");
  panel.id = "v3-drawer";
  panel.hidden = true;
  panel.setAttribute("aria-label", "持久任务管理");
  panel.innerHTML = [
    '<div class="v3-head"><h2>持久任务中心</h2><button type="button" id="v3-close">关闭</button></div>',
    '<p class="v3-muted" id="v3-context"></p>',
    '<form id="v3-schedule-form"><h3>创建计划任务</h3>',
    '<label>任务内容<input name="text" maxlength="1000" required placeholder="例如：检查 Pi 项目更新"></label>',
    '<div class="v3-duo"><label>多少分钟后开始<input name="minutesFromNow" type="number" min="0.25" max="525600" step="any" value="2" required></label>',
    '<label>每隔多少分钟重复（0 为单次）<input name="everyMinutes" type="number" min="0" max="525600" step="any" value="0" required></label></div>',
    '<button class="v3-primary" type="submit">创建任务</button></form>',
    '<form id="v3-background-form"><h3>交给后台子 Agent</h3>',
    '<textarea name="text" maxlength="4000" required placeholder="具体描述需要独立完成的工作"></textarea>',
    '<button class="v3-primary" type="submit">后台执行</button></form>',
    '<p id="v3-feedback" role="status" aria-live="polite"></p>',
    '<div class="v3-actions"><button id="v3-export">导出当前对话为 Markdown</button><button id="v3-refresh">刷新</button></div>',
    '<h3>计划任务</h3><div id="v3-schedules"></div>',
    '<h3>提醒</h3><div id="v3-reminders"></div>',
    '<h3>后台子 Agent</h3><div id="v3-background"></div>',
    '<p class="v3-muted" id="v3-knowledge"></p>',
    '<form id="v3-memory-form"><h3>长期记忆</h3>',
    '<p class="v3-muted">跨会话生效。你在这里写下的会直接记住；助手提交的要先批准。</p>',
    '<label>要记住的事实<input name="text" maxlength="280" required placeholder="例如：回复用简体中文"></label>',
    '<button class="v3-primary" type="submit">记住</button></form>',
    '<div id="v3-memory"></div>',
    '<form id="v3-skill-form"><h3>技能</h3>',
    '<p class="v3-muted">提示里只放名称。助手要用时才读取全文。</p>',
    '<label>名称<input name="name" maxlength="40" required></label>',
    '<label>什么时候用<input name="description" maxlength="180" required></label>',
    '<label>步骤<textarea name="body" maxlength="4000" required></textarea></label>',
    '<button class="v3-primary" type="submit">保存技能</button></form>',
    '<div id="v3-skills"></div>',
    '<p class="v3-muted">执行采用持久化检查点；周期按固定分钟间隔重复。修改与暂停不会自动清理旧的睡眠任务，但会阻止其过期触发。</p>',
  ].join("");
  document.body.append(toggle, panel);


return {toggle,panel};
}
