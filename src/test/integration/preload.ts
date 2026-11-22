import { mock } from "bun:test";

// server-only бросает вне условия react-server (например, в bun test).
// В тестах серверные модули импортируются намеренно, поэтому глушим маркер.
mock.module("server-only", () => ({}));
