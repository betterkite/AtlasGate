import { createApp } from "./app.js";

const app = createApp();

app.server.on("error", (error) => {
  app.stop();
  app.db.close();
  if (error.code === "EADDRINUSE") {
    console.error(`AtlasGate could not start: ${app.config.host}:${app.config.port} is already in use. Stop the existing process or set ATLASGATE_PORT to another port.`);
  } else {
    console.error(`AtlasGate could not start: ${error.message}`);
  }
  process.exitCode = 1;
});

app.server.listen(app.config.port, app.config.host, () => {
  console.log(`AtlasGate is running at http://${app.config.host}:${app.config.port}`);
  if (app.config.devMode) console.log("Development gateway key is enabled.");
});

function shutdown() {
  app.stop();
  app.server.close(() => {
    app.db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
