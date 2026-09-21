const chatMessages=document.getElementById("chat-messages");
const userInput=document.getElementById("user-input");
const sendButton=document.getElementById("send-button");
const typingIndicator=document.getElementById("typing-indicator");
const fin=document.getElementById("fin");
const chips=document.getElementById("chips");
const clearChatButton=document.getElementById("clear-chat");
const app=document.getElementById("app");
const insightPanel=document.getElementById("insight-panel");
const insightTitle=document.getElementById("insight-title");
const insightSubtitle=document.getElementById("insight-subtitle");
const insightContent=document.getElementById("insight-content");
const closeInsight=document.getElementById("close-insight");

const CHAT_STORAGE_KEY="fin_chat_history_v4";
const CONVERSATION_ID_KEY="fin_conversation_id_v1";
const MAX_STORED_MESSAGES=30;
const WELCOME="Hi! I’m Fin. Tell me what happened with your money, or ask me to pull something up from your planner. ✦";

let isProcessing=false;
let conversationId=getConversationId();
let chatHistory=loadHistory();

function createId(){return globalThis.crypto?.randomUUID?.()||`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}
function browserTimezone(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||"America/Denver"}catch{return"America/Denver"}}
function getConversationId(){try{let id=localStorage.getItem(CONVERSATION_ID_KEY);if(!id){id=createId();localStorage.setItem(CONVERSATION_ID_KEY,id)}return id}catch{return createId()}}
function loadHistory(){try{const x=JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)||"[]");return Array.isArray(x)?x.filter(validMessage).slice(-MAX_STORED_MESSAGES):[]}catch{return[]}}
function validMessage(m){return m&&(m.role==="user"||m.role==="assistant")&&typeof m.content==="string"&&m.content.trim()}
function saveHistory(){try{localStorage.setItem(CHAT_STORAGE_KEY,JSON.stringify(chatHistory.slice(-MAX_STORED_MESSAGES)))}catch{}}
function remember(role,content){if(!content?.trim())return;chatHistory.push({role,content:content.slice(0,4000)});chatHistory=chatHistory.slice(-MAX_STORED_MESSAGES);saveHistory()}

function setFinState(state){if(fin)fin.dataset.state=state}
function restartClass(name,duration=900){if(!fin)return;fin.classList.remove(name);void fin.offsetWidth;fin.classList.add(name);setTimeout(()=>fin.classList.remove(name),duration)}
function runFinAnimation(name){if(name==="income-success"){restartClass("book-flip",1450);setTimeout(()=>restartClass("success-pop",850),100)}else if(name==="notion-success")restartClass("success-pop",850)}

function openVisualization(v){if(!v||!window.FinVisualizations)return;insightTitle.textContent=v.title||"Your breakdown";insightSubtitle.textContent=v.subtitle||"";insightContent.innerHTML=window.FinVisualizations.render(v);app.classList.add("insight-open");insightPanel.setAttribute("aria-hidden","false");setTimeout(()=>restartClass("success-pop",850),100)}
function closeVisualization(){app.classList.remove("insight-open");insightPanel.setAttribute("aria-hidden","true")}
closeInsight?.addEventListener("click",closeVisualization);

function renderConversation(){chatMessages.innerHTML="";if(!chatHistory.length){addMessage("assistant",WELCOME);chips.hidden=false;return}chatHistory.forEach(m=>addMessage(m.role,m.content));chips.hidden=true}
renderConversation();
window.addEventListener("load",()=>{if(!window.matchMedia("(prefers-reduced-motion: reduce)").matches)restartClass("enter",1000)});

userInput?.addEventListener("input",function(){this.style.height="auto";this.style.height=`${Math.min(this.scrollHeight,125)}px`});
userInput?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}});
sendButton?.addEventListener("click",sendMessage);
chips?.addEventListener("click",e=>{const c=e.target.closest(".chip");if(!c||isProcessing)return;userInput.value=c.dataset.q||"";sendMessage()});
clearChatButton?.addEventListener("click",()=>{if(isProcessing)return;chatHistory=[];try{localStorage.removeItem(CHAT_STORAGE_KEY);conversationId=createId();localStorage.setItem(CONVERSATION_ID_KEY,conversationId)}catch{}closeVisualization();renderConversation();userInput?.focus()});

async function sendMessage(){
	if(!userInput||!sendButton)return;
	const message=userInput.value.trim();if(!message||isProcessing)return;
	const requestId=createId();
	isProcessing=true;userInput.disabled=true;sendButton.disabled=true;
	addMessage("user",message);remember("user",message);chips.hidden=true;userInput.value="";userInput.style.height="auto";
	typingIndicator?.classList.add("visible");setFinState("thinking");
	try{
		const response=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:chatHistory,timezone:browserTimezone(),conversationId,clientId:conversationId,memoryKey:conversationId,requestId})});
		if(!response.ok){let detail="";try{detail=(await response.json())?.error||""}catch{}throw new Error(detail||`Fin returned ${response.status}`)}
		if(!response.body)throw new Error("Fin returned an empty response.");
		const el=document.createElement("div");el.className="message assistant-message";chatMessages.appendChild(el);
		let responseText="",buffer="",done=false;const reader=response.body.getReader(),decoder=new TextDecoder();
		const append=content=>{if(!content)return;responseText+=content;renderRichAssistant(el,responseText);typingIndicator?.classList.remove("visible");setFinState("talking");scrollBottom()};
		while(!done){const chunk=await reader.read();if(chunk.done){buffer+=decoder.decode();const parsed=consumeSseEvents(`${buffer}\n\n`);done=handleEvents(parsed.events,append)||done;break}buffer+=decoder.decode(chunk.value,{stream:true});const parsed=consumeSseEvents(buffer);buffer=parsed.buffer;done=handleEvents(parsed.events,append)}
		if(!responseText.trim())throw new Error("Fin didn't return any text.");
		renderRichAssistant(el,responseText);remember("assistant",responseText.trim());
	}catch(error){console.error("Fin chat error:",error);addMessage("assistant","I couldn’t reach my notes just then. Your message is still here, so you can try again.")}
	finally{typingIndicator?.classList.remove("visible");setFinState("idle");isProcessing=false;userInput.disabled=false;sendButton.disabled=false;userInput.focus()}
}

function handleEvents(events,appendText){for(const data of events){if(data==="[DONE]")return true;try{const json=JSON.parse(data);if(json.type==="visualization"&&json.visualization){openVisualization(json.visualization);continue}if(json.type==="animation"&&json.name){runFinAnimation(json.name);continue}const content=typeof json.response==="string"?json.response:json.choices?.[0]?.delta?.content||json.content||"";if(content)appendText(content)}catch(error){console.warn("Could not parse Fin stream:",data,error)}}return false}
function consumeSseEvents(buffer){const normalized=buffer.replace(/\r/g,"");const events=[];let remaining=normalized,idx;while((idx=remaining.indexOf("\n\n"))!==-1){const raw=remaining.slice(0,idx);remaining=remaining.slice(idx+2);const lines=raw.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart());if(lines.length)events.push(lines.join("\n"))}return{events,buffer:remaining}}

function addMessage(role,content){if(!chatMessages)return;const el=document.createElement("div");el.className=`message ${role}-message`;if(role==="assistant")renderRichAssistant(el,content);else{const p=document.createElement("p");p.textContent=content;el.appendChild(p)}chatMessages.appendChild(el);scrollBottom()}
function scrollBottom(){if(chatMessages)chatMessages.scrollTop=chatMessages.scrollHeight}

function renderRichAssistant(container,source){container.replaceChildren();const lines=source.replace(/\r/g,"").split("\n");let list=null,listType=null;const flush=()=>{list=null;listType=null};for(const raw of lines){const t=raw.trim();if(!t){flush();continue}if(t==="---"){flush();const d=document.createElement("div");d.className="divider";container.appendChild(d);continue}if(t.startsWith("### ")){flush();const h=document.createElement("h3");appendInline(h,t.slice(4));container.appendChild(h);continue}if(t.startsWith("#### ")){flush();const h=document.createElement("h4");appendInline(h,t.slice(5));container.appendChild(h);continue}let m=t.match(/^[-•]\s+(.+)$/);if(m){if(!list||listType!=="ul"){list=document.createElement("ul");listType="ul";container.appendChild(list)}const li=document.createElement("li");appendInline(li,m[1]);list.appendChild(li);continue}m=t.match(/^\d+[.)]\s+(.+)$/);if(m){if(!list||listType!=="ol"){list=document.createElement("ol");listType="ol";container.appendChild(list)}const li=document.createElement("li");appendInline(li,m[1]);list.appendChild(li);continue}m=t.match(/^(TIP|NOTE|WATCH|HEADS UP):\s*(.+)$/i);if(m){flush();const box=document.createElement("div");box.className="callout"+(/WATCH|HEADS UP/i.test(m[1])?" warn":"");const title=document.createElement("span");title.className="callout-title";title.textContent=m[1];const body=document.createElement("div");appendInline(body,m[2]);box.append(title,body);container.appendChild(box);continue}flush();const p=document.createElement("p");appendInline(p,t);container.appendChild(p)}}
function appendInline(parent,text){const re=/(\*\*[^*]+\*\*|`[^`]+`)/g;let last=0,m;while((m=re.exec(text))){if(m.index>last)parent.append(document.createTextNode(text.slice(last,m.index)));const token=m[0];if(token.startsWith("**")){const s=document.createElement("strong");s.textContent=token.slice(2,-2);parent.appendChild(s)}else{const c=document.createElement("code");c.textContent=token.slice(1,-1);parent.appendChild(c)}last=m.index+token.length}if(last<text.length)parent.append(document.createTextNode(text.slice(last)))}
