// `claude` falso para os testes do ClaudeSession: reproduz uma fixture de test/fixtures/claude-cli/.
// Uso: node fake-claude.mjs <fixture.json> [args do claude…]. Fixture sem `code` (interrupção) fica esperando o kill.
import fs from "node:fs";

const fx = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const ev of fx.events) process.stdout.write(JSON.stringify(ev) + "\n");
if (fx.stderr) process.stderr.write(fx.stderr);
if (fx.code === null) setInterval(() => {}, 1000);
else process.stdout.end(() => process.exit(fx.code));
