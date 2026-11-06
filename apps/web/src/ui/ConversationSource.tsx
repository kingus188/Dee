import { Icon } from "./Icon.js";

/** Native selection preserves keyboard and screen-reader behavior on every screen size. */
export function ConversationSource({ source, onAssistant, onTeams }: {
  source: "assistant" | "teams"; onAssistant: () => void; onTeams: () => void;
}) {
  return <div className="conversation-source">
    {source === "teams" ? <Icon name="users-round" /> : <Icon name="sparkles" />}
    <select aria-label="切换对话来源" value={source} onChange={event => { if (event.target.value === "teams") onTeams(); else onAssistant(); }}>
      <option value="assistant">小 D 助手</option><option value="teams">Teams</option>
    </select>
    <Icon name="chevron-down" />
  </div>;
}
