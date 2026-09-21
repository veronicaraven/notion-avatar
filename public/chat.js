/**
 * Fin: chat frontend
 *
 * - Streams replies from /api/chat
 * - Remembers recent conversations across reloads with localStorage
 * - Sends a stable conversationId so the Worker can use FIN_MEMORY / KV
 * - Restores previous messages into the chat UI
 * - Keeps Fin's animated idle / thinking / talking states
 */

const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const fin = document.getElementById("fin");
const chips = document.getElementById("chips");
const clearChatButton = document.getElementById("clear-chat");

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

const CHAT_STORAGE_KEY = "fin_chat_history_v2";
const CONVERSATION_ID_KEY = "fin_conversation_id_v1";

const MAX_STORED_MESSAGES = 30;
const MAX_MESSAGE_LENGTH = 4000;

const WELCOME_MESSAGE =
	"Hi, I'm Fin. I can help you understand your spending, keep track of what comes in and goes out, and make room for the things you're planning.";

// -----------------------------------------------------------------------------
// Conversation identity
// -----------------------------------------------------------------------------

function createId() {
	if (globalThis.crypto?.randomUUID) {
		return crypto.randomUUID();
	}

	return [
		Date.now().toString(36),
		Math.random().toString(36).slice(2),
		Math.random().toString(36).slice(2),
	].join("-");
}

function getConversationId() {
	try {
		let id = localStorage.getItem(CONVERSATION_ID_KEY);

		if (!id) {
			id = createId();
			localStorage.setItem(CONVERSATION_ID_KEY, id);
		}

		return id;
	} catch (error) {
		console.warn("Could not access conversation ID storage:", error);
		return createId();
	}
}

let conversationId = getConversationId();

// -----------------------------------------------------------------------------
// Chat memory
// -----------------------------------------------------------------------------

function validStoredMessage(message) {
	return (
		message &&
		(message.role === "user" || message.role === "assistant") &&
		typeof message.content === "string" &&
		message.content.trim().length > 0
	);
}

function loadChatHistory() {
	try {
		const raw = localStorage.getItem(CHAT_STORAGE_KEY);

		if (!raw) {
			return [];
		}

		const parsed = JSON.parse(raw);

		if (!Array.isArray(parsed)) {
			return [];
		}

		return parsed
			.filter(validStoredMessage)
			.slice(-MAX_STORED_MESSAGES)
			.map((message) => ({
				role: message.role,
				content: message.content.slice(0, MAX_MESSAGE_LENGTH),
			}));
	} catch (error) {
		console.warn("Could not restore Fin's conversation:", error);
		return [];
	}
}

function saveChatHistory() {
	try {
		const trimmed = chatHistory
			.filter(validStoredMessage)
			.slice(-MAX_STORED_MESSAGES)
			.map((message) => ({
				role: message.role,
				content: message.content.slice(0, MAX_MESSAGE_LENGTH),
			}));

		localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(trimmed));
	} catch (error) {
		console.warn("Could not save Fin's conversation:", error);
	}
}

function rememberMessage(role, content) {
	if (!content || !content.trim()) {
		return;
	}

	chatHistory.push({
		role,
		content: content.slice(0, MAX_MESSAGE_LENGTH),
	});

	chatHistory = chatHistory.slice(-MAX_STORED_MESSAGES);
	saveChatHistory();
}

let chatHistory = loadChatHistory();
let isProcessing = false;

// -----------------------------------------------------------------------------
// Initial rendering
// -----------------------------------------------------------------------------

function clearRenderedMessages() {
	if (!chatMessages) return;
	chatMessages.innerHTML = "";
}

function renderConversation() {
	if (!chatMessages) return;

	clearRenderedMessages();

	if (chatHistory.length === 0) {
		addMessageToChat("assistant", WELCOME_MESSAGE);
		return;
	}

	for (const message of chatHistory) {
		addMessageToChat(message.role, message.content);
	}

	if (chips) {
		chips.hidden = chatHistory.length > 0;
	}
}

renderConversation();

// -----------------------------------------------------------------------------
// Fin animation state
// -----------------------------------------------------------------------------

function setFinState(state) {
	if (!fin) return;
	fin.dataset.state = state;
}

// -----------------------------------------------------------------------------
// Input behavior
// -----------------------------------------------------------------------------

if (userInput) {
	userInput.addEventListener("input", function () {
		this.style.height = "auto";
		this.style.height = `${Math.min(this.scrollHeight, 120)}px`;
	});

	userInput.addEventListener("keydown", function (event) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			sendMessage();
		}
	});
}

if (sendButton) {
	sendButton.addEventListener("click", sendMessage);
}

if (chips) {
	chips.addEventListener("click", (event) => {
		const chip = event.target.closest(".chip");

		if (!chip || isProcessing || !userInput) {
			return;
		}

		const question = chip.dataset.q;

		if (!question) {
			return;
		}

		userInput.value = question;
		sendMessage();
	});
}

if (clearChatButton) {
	clearChatButton.addEventListener("click", clearConversation);
}

// -----------------------------------------------------------------------------
// Clear conversation
// -----------------------------------------------------------------------------

function clearConversation() {
	if (isProcessing) return;

	chatHistory = [];

	try {
		localStorage.removeItem(CHAT_STORAGE_KEY);

		// New conversation = new KV memory thread.
		conversationId = createId();
		localStorage.setItem(CONVERSATION_ID_KEY, conversationId);
	} catch (error) {
		console.warn("Could not clear conversation storage:", error);
	}

	renderConversation();

	if (chips) {
		chips.hidden = false;
	}

	if (userInput) {
		userInput.focus();
	}
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

async function sendMessage() {
	if (!userInput || !sendButton) {
		return;
	}

	const message = userInput.value.trim();

	if (!message || isProcessing) {
		return;
	}

	isProcessing = true;

	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);
	rememberMessage("user", message);

	if (chips) {
		chips.hidden = true;
	}

	userInput.value = "";
	userInput.style.height = "auto";

	if (typingIndicator) {
		typingIndicator.classList.add("visible");
	}

	setFinState("thinking");

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messages: chatHistory,
				timezone: getBrowserTimezone(),

				/*
				 * Persistent identifier for server-side FIN_MEMORY.
				 *
				 * Sending all three names is intentional:
				 * older/newer Worker versions can use whichever field
				 * they support, while unknown JSON fields are harmless.
				 */
				conversationId,
				clientId: conversationId,
				memoryKey: conversationId,
			}),
		});

		if (!response.ok) {
			let serverMessage = "";

			try {
				const body = await response.json();
				serverMessage = body?.error || body?.message || "";
			} catch {
				// Response may not be JSON.
			}

			throw new Error(
				serverMessage || `Fin's server returned ${response.status}.`
			);
		}

		if (!response.body) {
			throw new Error("Fin returned an empty response.");
		}

		let assistantTextEl = null;
		let responseText = "";

		const appendText = (content) => {
			if (!content) return;

			if (!assistantTextEl) {
				const element = document.createElement("div");
				element.className = "message assistant-message";

				assistantTextEl = document.createElement("p");
				element.appendChild(assistantTextEl);

				chatMessages?.appendChild(element);

				if (typingIndicator) {
					typingIndicator.classList.remove("visible");
				}

				setFinState("talking");
			}

			responseText += content;
			assistantTextEl.textContent = responseText;

			scrollChatToBottom();
		};

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		let buffer = "";
		let sawDone = false;

		while (!sawDone) {
			const { done, value } = await reader.read();

			if (done) {
				buffer += decoder.decode();

				const finalParsed = consumeSseEvents(`${buffer}\n\n`);
				handleEvents(finalParsed.events, appendText);

				break;
			}

			buffer += decoder.decode(value, { stream: true });

			const parsed = consumeSseEvents(buffer);

			buffer = parsed.buffer;
			sawDone = handleEvents(parsed.events, appendText);
		}

		if (responseText.trim()) {
			rememberMessage("assistant", responseText.trim());
		} else {
			throw new Error("Fin didn't return any text.");
		}
	} catch (error) {
		console.error("Fin chat error:", error);

		const fallback =
			"I couldn't reach my notes just then. Your message is still here, so you can try sending it again.";

		addMessageToChat("assistant", fallback);

		/*
		 * We intentionally do NOT save this temporary connection-error
		 * message to chat history. It isn't part of Fin's real conversation.
		 */
	} finally {
		if (typingIndicator) {
			typingIndicator.classList.remove("visible");
		}

		setFinState("idle");

		isProcessing = false;

		userInput.disabled = false;
		sendButton.disabled = false;

		userInput.focus();
	}
}

// -----------------------------------------------------------------------------
// SSE stream handling
// -----------------------------------------------------------------------------

function handleEvents(events, appendText) {
	for (const data of events) {
		if (data === "[DONE]") {
			return true;
		}

		try {
			const json = JSON.parse(data);

			let content = "";

			// Cloudflare Workers AI streaming shape
			if (
				typeof json.response === "string" &&
				json.response.length > 0
			) {
				content = json.response;
			}

			// OpenAI-compatible streaming shape
			else if (
				typeof json.choices?.[0]?.delta?.content === "string"
			) {
				content = json.choices[0].delta.content;
			}

			// Optional generic shape
			else if (typeof json.content === "string") {
				content = json.content;
			}

			if (content) {
				appendText(content);
			}
		} catch (error) {
			console.warn("Could not parse streamed Fin response:", data, error);
		}
	}

	return false;
}

function consumeSseEvents(buffer) {
	const normalized = buffer.replace(/\r/g, "");

	const events = [];
	let remaining = normalized;

	let eventEndIndex;

	while ((eventEndIndex = remaining.indexOf("\n\n")) !== -1) {
		const rawEvent = remaining.slice(0, eventEndIndex);

		remaining = remaining.slice(eventEndIndex + 2);

		const dataLines = [];

		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("data:")) {
				dataLines.push(
					line.slice("data:".length).trimStart()
				);
			}
		}

		if (dataLines.length > 0) {
			events.push(dataLines.join("\n"));
		}
	}

	return {
		events,
		buffer: remaining,
	};
}

// -----------------------------------------------------------------------------
// UI helpers
// -----------------------------------------------------------------------------

function addMessageToChat(role, content) {
	if (!chatMessages) return;

	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;

	const paragraph = document.createElement("p");
	paragraph.textContent = content;

	messageEl.appendChild(paragraph);
	chatMessages.appendChild(messageEl);

	scrollChatToBottom();
}

function scrollChatToBottom() {
	if (!chatMessages) return;

	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function getBrowserTimezone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Denver";
	} catch {
		return "America/Denver";
	}
}
