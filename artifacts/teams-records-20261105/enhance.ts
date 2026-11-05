import { teamsRecords } from "../../apps/web/src/chat/TeamsRecords.js";

// 保留线上较新的主界面，仅增强原消息展示；完整源码构建由 TeamsRecords 组件负责。
export function startTeamsRecords(document: Document) {
  function render() {
    for (const turn of document.querySelectorAll<HTMLElement>(".chat-turn")) {
      let host=turn.querySelector<HTMLElement>(":scope > .teams-records-inline");
      if(host&&!host.dataset.enhanced)continue;
      const activities=[...turn.querySelectorAll(".turn-activity pre")].map((node,index)=>({id:String(index),name:"teams_history",status:"completed" as const,text:node.textContent??""}));
      const records=teamsRecords(activities);
      if(!records.length)continue;
      turn.querySelector(":scope > .teams-media-inline")?.remove();
      let disclosure=turn.querySelector<HTMLDetailsElement>(":scope > .teams-records-summary");
      if(!disclosure){
        disclosure=document.createElement("details");disclosure.className="teams-records-summary";
        const summary=document.createElement("summary");summary.textContent="助手说明";disclosure.append(summary);
        turn.insertBefore(disclosure,turn.querySelector(":scope > .assistant-row"));
        disclosure.addEventListener("toggle",()=>updateReplies());
      }
      const updateReplies=()=>{for(const reply of turn.querySelectorAll<HTMLElement>(":scope > .assistant-row .response-card"))reply.hidden=!disclosure!.open;};
      const firstReply=turn.querySelector(":scope > .assistant-row");
      if(firstReply&&disclosure.nextElementSibling!==firstReply)turn.insertBefore(disclosure,firstReply);
      updateReplies();
      const signature=JSON.stringify(records);
      if(host?.dataset.signature===signature)continue;
      host??=document.createElement("div");host.className="teams-records-inline";host.dataset.enhanced="true";host.dataset.signature=signature;host.replaceChildren();
      const chats=new Map<string,typeof records>();
      for(const record of records)chats.set(record.chatId,[...(chats.get(record.chatId)??[]),record]);
      for(const messages of chats.values()){
        const group=document.createElement("section"),heading=document.createElement("h3"),list=document.createElement("ol");
        group.className="teams-records-chat";heading.textContent=messages[0].chatLabel;group.append(heading,list);host.append(group);
        for(const message of messages){
          const row=document.createElement("li"),header=document.createElement("header"),sender=document.createElement("strong"),time=document.createElement("time");
          row.className="teams-record";row.dataset.teamsMessageId=message.id;sender.textContent=message.sender;time.dateTime=message.createdAt;time.textContent=new Date(message.createdAt).toLocaleString("zh-CN",{hour12:false});
          header.append(sender,time);row.append(header);list.append(row);
          if(message.deleted||message.text){const text=document.createElement("p");text.className=message.deleted?"teams-record-deleted":"teams-record-text";text.textContent=message.deleted?"此消息已删除":message.text;row.append(text);}
          if(message.media.length){const attachments=document.createElement("div");attachments.className="teams-record-attachments";row.append(attachments);
            for(const item of message.media){
              if(item.kind==="image"&&item.previewUrl){const link=document.createElement("a"),image=document.createElement("img");link.href=item.previewUrl;link.target="_blank";link.rel="noopener noreferrer";link.className="msg-image-link";image.className="msg-image-thumb";image.src=item.previewUrl;image.alt=item.name;image.loading="lazy";link.append(image);attachments.append(link);}
              else{const card=document.createElement("div"),label=document.createElement(item.url?"a":"span");card.className="msg-file-card";label.textContent=item.name;
                if(item.url){(label as HTMLAnchorElement).href=item.url;(label as HTMLAnchorElement).target="_blank";(label as HTMLAnchorElement).rel="noopener noreferrer";}
                else{const state=document.createElement("small");state.textContent=item.status==="failed"?"保存失败":item.status==="pending"?"正在保存":"暂无可用链接";label.append(state);}
                card.append(label);attachments.append(card);}
            }
          }
        }
      }
      if(!host.isConnected)turn.insertBefore(host,turn.querySelector(":scope > .turn-activities"));
    }
  }
  let queued=false;
  const observer=new document.defaultView!.MutationObserver(()=>{if(!queued){queued=true;queueMicrotask(()=>{queued=false;render();});}});
  render();observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  return ()=>observer.disconnect();
}
if(typeof document!=="undefined")startTeamsRecords(document);
