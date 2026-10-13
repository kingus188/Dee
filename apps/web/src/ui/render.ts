
export function createUiRender() {
// ---- 增量渲染：只替换内容变了的子节点，没变的原样保留 ----
// 每次推送都整块重建会让淡入动画重放、滚动和展开状态丢失，看起来就是闪烁
function patchChildren(target: HTMLElement, staging: HTMLElement) {
    const next = Array.from(staging.children) as (Element & {
        __sig?: string;
    })[];
    const prev = Array.from(target.children) as (Element & {
        __sig?: string;
    })[];
    next.forEach((node, i) => {
        node.__sig = node.outerHTML;
        const old = prev[i];
        if (old && old.__sig === node.__sig)
            return;
        // 同一位置的更新（比如工具结果到达、流式文字增长）不再播放入场动画
        if (old) {
            node.classList.add('no-anim');
            target.replaceChild(node, old);
        }
        else {
            target.appendChild(node);
        }
    });
    for (let i = next.length; i < prev.length; i++)
        prev[i].remove();
}

return { patchChildren };
}
