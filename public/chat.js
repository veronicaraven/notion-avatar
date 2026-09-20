/**
 * Fin: chat frontend
 *
 * Handles the chat UI and talks to /api/chat. Fin's mood is driven by
 * data-state on #fin: "idle", "thinking" (waiting) and "talking" (streaming).
 */

// DOM elements
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input");
const sendButton = document.getElementById("send-button");
const typingIndicator = document.getElementById("typing-indicator");
const fin = document.getElementById("fin");
const chips = document.getElementById("chips");

// Chat state
let chatHistory = [
	{
		role: "assistant",
		content:
			"Boo! Your planner is open. Tell me what you buy or earn and I'll log it, or tell me about something big you're saving for.",
	},
];
let isProcessing = false;

function setFinState(state) {
	fin.dataset.state = state;
}

// Auto-resize textarea as user types
userInput.addEventListener("input", function () {
	this.style.height = "auto";
	this.style.height = this.scrollHeight + "px";
});

// Send message on Enter (without Shift)
userInput.addEventListener("keydown", function (e) {
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		sendMessage();
	}
});

sendButton.addEventListener("click", sendMessage);

// Quick-question chips
chips.addEventListener("click", (e) => {
	const chip = e.target.closest(".chip");
	if (!chip || isProcessing) return;
	userInput.value = chip.dataset.q;
	sendMessage();
});

/**
 * Sends a message to the chat API and streams the reply.
 */
async function sendMessage() {
	const message = userInput.value.trim();
	if (message === "" || isProcessing) return;

	isProcessing = true;
	userInput.disabled = true;
	sendButton.disabled = true;

	addMessageToChat("user", message);
	chips.hidden = true;

	userInput.value = "";
	userInput.style.height = "auto";

	typingIndicator.classList.add("visible");
	setFinState("thinking");

	chatHistory.push({ role: "user", content: message });

	try {
		const response = await fetch("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: chatHistory,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			}),
		});

		if (!response.ok) throw new Error("Failed to get response");
		if (!response.body) throw new Error("Response body is null");

		// The reply bubble is created when the first words arrive
		let assistantTextEl = null;
		let responseText = "";

		const appendText = (content) => {
			if (!assistantTextEl) {
				const el = document.createElement("div");
				el.className = "message assistant-message";
				assistantTextEl = document.createElement("p");
				el.appendChild(assistantTextEl);
				chatMessages.appendChild(el);
				typingIndicator.classList.remove("visible");
				setFinState("talking");
			}
			responseText += content;
			assistantTextEl.textContent = responseText;
			chatMessages.scrollTop = chatMessages.scrollHeight;
		};

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let sawDone = false;

		while (!sawDone) {
			const { done, value } = await reader.read();

			if (done) {
				// Flush anything left in the buffer
				sawDone = handleEvents(consumeSseEvents(buffer + "\n\n").events, appendText);
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			const parsed = consumeSseEvents(buffer);
			buffer = parsed.buffer;
			sawDone = handleEvents(parsed.events, appendText);
		}

		if (responseText.length > 0) {
			chatHistory.push({ role: "assistant", content: responseText });
		}
	} catch (error) {
		console.error("Error:", error);
		addMessageToChat(
			"assistant",
			"Oh no, a gust of spooky wind blew my notes away. Could you say that again?",
		);
	} finally {
		typingIndicator.classList.remove("visible");
		setFinState("idle");

		isProcessing = false;
		userInput.disabled = false;
		sendButton.disabled = false;
		userInput.focus();
	}
}

/**
 * Pulls text out of each SSE event. Returns true once [DONE] is seen.
 */
function handleEvents(events, appendText) {
	for (const data of events) {
		if (data === "[DONE]") return true;
		try {
			const json = JSON.parse(data);
			// Workers AI format (response) or OpenAI format (choices[0].delta.content)
			let content = "";
			if (typeof json.response === "string" && json.response.length > 0) {
				content = json.response;
			} else if (json.choices?.[0]?.delta?.content) {
				content = json.choices[0].delta.content;
			}
			if (content) appendText(content);
		} catch (e) {
			console.error("Error parsing SSE data as JSON:", e, data);
		}
	}
	return false;
}

/**
 * Adds a message to the chat. Uses textContent so nothing typed is run as HTML.
 */
function addMessageToChat(role, content) {
	const messageEl = document.createElement("div");
	messageEl.className = `message ${role}-message`;
	const p = document.createElement("p");
	p.textContent = content;
	messageEl.appendChild(p);
	chatMessages.appendChild(messageEl);
	chatMessages.scrollTop = chatMessages.scrollHeight;
}

function consumeSseEvents(buffer) {
	let normalized = buffer.replace(/\r/g, "");
	const events = [];
	let eventEndIndex;
	while ((eventEndIndex = normalized.indexOf("\n\n")) !== -1) {
		const rawEvent = normalized.slice(0, eventEndIndex);
		normalized = normalized.slice(eventEndIndex + 2);

		const dataLines = [];
		for (const line of rawEvent.split("\n")) {
			if (line.startsWith("data:")) {
				dataLines.push(line.slice("data:".length).trimStart());
			}
		}
		if (dataLines.length === 0) continue;
		events.push(dataLines.join("\n"));
	}
	return { events, buffer: normalized };
}
