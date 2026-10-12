import type { BrowserView } from "../types.js";
import { escapeHtml, formatDuration, formatTime } from "../ui/format.js";
import type { AppState, AppActions } from "../state.js";

export function createTasksPanels(state: AppState, getActions: () => Pick<AppActions, "stagingFor">) {
// 渲染记事本
function renderNotes(notes: BrowserView["notes"]) {
    const todoListEl = getActions().stagingFor('todo-list');
    const memoListEl = getActions().stagingFor('memo-list');
    if (todoListEl) {
        todoListEl.innerHTML = '';
        if (notes && Array.isArray(notes.todos) && notes.todos.length > 0) {
            notes.todos.forEach(t => {
                const item = document.createElement('div');
                item.className = 'todo-item' + (t.done ? ' done' : '');
                item.innerHTML = `
              <input type="checkbox" ${t.done ? 'checked' : ''} disabled>
              <span>${escapeHtml(t.text)}</span>
            `;
                todoListEl.appendChild(item);
            });
        }
        else {
            todoListEl.innerHTML = '<span class="empty-placeholder">暂无待办事项</span>';
        }
    }
    if (memoListEl) {
        memoListEl.innerHTML = '';
        if (notes && Array.isArray(notes.memos) && notes.memos.length > 0) {
            notes.memos.forEach(m => {
                const item = document.createElement('div');
                item.className = 'memo-item';
                item.innerHTML = `📌 <span>${escapeHtml(typeof m === 'string' ? m : m.text || JSON.stringify(m))}</span>`;
                memoListEl.appendChild(item);
            });
        }
        else {
            memoListEl.innerHTML = '<span class="empty-placeholder">暂无备忘录</span>';
        }
    }
}

// 渲染定时提醒面板
function renderReminders(reminders: BrowserView["reminders"]) {
    const listEl = getActions().stagingFor('reminder-list');
    if (!listEl)
        return;
    listEl.innerHTML = '';
    if (!Array.isArray(reminders) || reminders.length === 0) {
        listEl.innerHTML = '<span class="empty-placeholder">暂无定时提醒</span>';
        return;
    }
    const now = Date.now();
    reminders.forEach(r => {
        const item = document.createElement('div');
        const isFired = (r.status === 'fired');
        item.className = 'reminder-item' + (isFired ? ' fired' : '');
        let badgeHtml = '';
        if (isFired) {
            badgeHtml = '<span class="reminder-badge fired">已提醒</span>';
        }
        else {
            const diff = r.at - now;
            const countdown = diff > 0 ? `倒计时 ${formatDuration(diff)}` : '即将触发';
            badgeHtml = `<span class="reminder-badge scheduled" data-at="${r.at}">${escapeHtml(countdown)}</span>`;
        }
        item.innerHTML = `
          <div class="reminder-info">
            <span class="reminder-text">⏰ ${escapeHtml(r.text)}</span>
            <span class="reminder-time">${escapeHtml(formatTime(r.at))}</span>
          </div>
          ${badgeHtml}
        `;
        listEl.appendChild(item);
    });
}

// 渲染持久任务面板（按 owner 缩进成树）
const TASK_KIND_MAP: Record<string, string> = {
    'pi.generation': '调用模型',
    'pi.tool': '执行工具',
    'app.reminder': '定时提醒',
    'pi.compaction': '状态压缩'
};

const TASK_STATUS_MAP: Record<string, string> = {
    'pending': '排队',
    'running': '运行中',
    'waiting': '等待中',
    'completing': '收尾'
};

function renderTasks(tasks: BrowserView["tasks"]) {
    const treeEl = getActions().stagingFor('task-tree');
    if (!treeEl)
        return;
    treeEl.innerHTML = '';
    if (!Array.isArray(tasks) || tasks.length === 0) {
        treeEl.innerHTML = '<span class="empty-placeholder">空闲，没有正在运行的任务</span>';
        return;
    }
    // 构建 owner 父子树
    const taskMap = new Map();
    const childrenMap = new Map<number, BrowserView["tasks"]>();
    const roots: BrowserView["tasks"] = [];
    tasks.forEach(t => {
        taskMap.set(t.id, t);
    });
    tasks.forEach(t => {
        if (t.owner && taskMap.has(t.owner)) {
            if (!childrenMap.has(t.owner)) {
                childrenMap.set(t.owner, []);
            }
            childrenMap.get(t.owner)!.push(t);
        }
        else {
            roots.push(t);
        }
    });
    // 递归渲染树节点
    function appendNode(task: BrowserView["tasks"][number], depth = 0) {
        const node = document.createElement('div');
        node.className = 'task-node';
        node.style.paddingLeft = (depth * 16 + 6) + 'px';
        const kindName = TASK_KIND_MAP[task.kind] || task.kind;
        const statusClass = task.status || 'pending';
        const statusText = TASK_STATUS_MAP[task.status] || task.status;
        const branchPrefix = depth > 0 ? '<span class="task-branch-icon">└─ </span>' : '';
        node.innerHTML = `
          <div class="task-main">
            ${branchPrefix}
            <span class="task-name" title="${escapeHtml(task.id)}">${escapeHtml(kindName)}</span>
          </div>
          <span class="task-badge ${escapeHtml(statusClass)}">${escapeHtml(statusText)}</span>
        `;
        treeEl!.appendChild(node);
        const children = childrenMap.get(task.id);
        if (children && children.length > 0) {
            children.forEach(child => appendNode(child, depth + 1));
        }
    }
    roots.forEach(root => appendNode(root, 0));
}
return { renderNotes, renderReminders, renderTasks };
}
