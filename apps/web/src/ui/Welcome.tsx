export function Welcome() {
  return (
<section className="welcome-view" aria-labelledby="welcome-title">
        <div className="welcome-heading"><p className="welcome-eyebrow">YOUR PERSONAL AI SPACE</p><h1 id="welcome-title">小 D<span className="heading-dot">.</span> 让想法，慢慢变成日常</h1><p className="welcome-description">记住你的偏好 · 整理生活灵感 · 把交代的事情继续做完</p></div>
        <div className="orbit-stage" aria-label="小 D 可以帮你做什么">
          <div className="orbit-glow" aria-hidden="true"></div><div className="orbit-ring ring-outer" aria-hidden="true"></div><div className="orbit-ring ring-middle" aria-hidden="true"></div><div className="orbit-ring ring-inner" aria-hidden="true"></div>
          <div className="orbit-words" aria-hidden="true"><span>记忆 · 灵感</span><span>每件小事 都有回应</span><span>思考，连接，行动</span><span>让日常井井有条</span><span>陪你把想法实现</span></div>
          <div className="assistant-orb" role="img" aria-label="小 D 的智能光球"><div className="orb-source"></div></div>
          <button type="button" className="feature-node feature-read" data-prompt="帮我阅读一个公开网页并整理重点，请先问我要链接"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#globe"/></svg></span><span>网页阅读</span></button><button type="button" className="feature-node feature-notes" data-open-group="notes"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#notebook-pen"/></svg></span><span>笔记与待办</span></button><button type="button" className="feature-node feature-skills" data-open-group="skills"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#sparkles"/></svg></span><span>常用技能</span></button><button type="button" className="feature-node feature-memory" data-open-group="memory"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#brain"/></svg></span><span>长期记忆</span></button><button type="button" className="feature-node feature-tasks" data-open-group="tasks"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#clock-3"/></svg></span><span>提醒与计划</span></button><button type="button" className="feature-node feature-knowledge" data-prompt="帮我在知识库中查找资料，请先问我想找什么"><span className="feature-icon"><svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#book-open"/></svg></span><span>知识检索</span></button>
          <span className="orbit-point point-one" aria-hidden="true"></span><span className="orbit-point point-two" aria-hidden="true"></span><span className="orbit-point point-three" aria-hidden="true"></span>
        </div>
        <p className="welcome-caption"><span></span>从一句话开始，小 D 会记得接下来要做的事</p>
      </section>
  );
}
