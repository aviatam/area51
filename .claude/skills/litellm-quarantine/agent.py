"""Disposable two-turn LiteLLM task agent. Only a scoped relay capability enters the VM."""
import importlib.metadata
import json
import os
import time

# Disable LiteLLM's optional remote model-cost fetch; the VM has no general egress.
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
import litellm

assert not os.environ.get("GROQ_API_KEY")
assert not os.environ.get("GITHUB_TOKEN")
assert importlib.metadata.version("litellm") == "1.106.2"
config = json.load(open(os.environ.get("AREA51_RELAY_CONFIG", "/run/area51/litellm-relay.json"), encoding="utf-8"))
history = [{"role": "system", "content": "You are a task assistant. Answer briefly in plain English. Use no tools."}]
answers = []
for task in ["Explain in one sentence why secrets should stay outside an agent VM.",
             "Give one practical example based on your previous answer."]:
    history.append({"role": "user", "content": task})
    result = litellm.completion(
        model="openai/area51-litellm-demo",
        api_base=config["url"], api_key=config["token"],
        messages=history, max_retries=0, timeout=55,
    )
    answer = result.choices[0].message.content
    assert isinstance(answer, str) and answer.strip()
    answers.append(answer)
    history.append({"role": "assistant", "content": answer})
print(json.dumps({"event": "agent-ready", "litellm": importlib.metadata.version("litellm"),
                  "turns": len(answers), "answers": answers}), flush=True)
# Keep the actual process alive so the host can demonstrate stopping this workload.
while True:
    time.sleep(1)
