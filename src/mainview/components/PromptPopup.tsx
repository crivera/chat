/** @jsxImportSource preact */
import { activePrompts, respondToPrompt, selectThread } from "../state";

function btnClass(label: string): string {
  const l = label.toLowerCase();
  if (l === "yes") return "prompt-popup-btn-yes";
  if (l === "no" || l === "cancel") return "prompt-popup-btn-no";
  if (l === "always") return "prompt-popup-btn-always";
  return "prompt-popup-btn-option";
}

export function PromptPopup() {
  const prompts = [...activePrompts.value.values()];
  if (prompts.length === 0) return null;

  return (
    <div class="prompt-popup-stack">
      {prompts.map((prompt) => {
        const isSelection = prompt.options.length > 3;
        return (
          <div key={prompt.id} class="prompt-popup">
            <div class="prompt-popup-header">
              <div class="prompt-popup-title">
                <span class="prompt-popup-folder">{prompt.folderName}</span>
                <span class="prompt-popup-thread">{prompt.threadTitle}</span>
              </div>
            </div>
            <div class="prompt-popup-question">{prompt.question}</div>
            <div
              class={
                isSelection
                  ? "prompt-popup-actions prompt-popup-actions-list"
                  : "prompt-popup-actions"
              }
            >
              {prompt.options.map((opt) => (
                <button
                  key={opt.keystroke}
                  class={`prompt-popup-btn ${btnClass(opt.label)}`}
                  onClick={() => respondToPrompt(prompt.id, opt.keystroke)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <div class="prompt-popup-footer">
              <button
                class="prompt-popup-goto"
                onClick={() => selectThread(prompt.id)}
              >
                Go to terminal
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
