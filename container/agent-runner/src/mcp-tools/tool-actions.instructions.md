Use `tool_action` for named actions the operator has registered with the host.
Supply only the tool name and its arguments. Never supply an agent identity,
endpoint, credential or approval decision. The tool acknowledges submission;
the system will report execution, denial or pending administrator approval.
Do not resubmit while a request is pending. If execution fails or times out, ask
the operator to reconcile the external service before submitting a new request.
