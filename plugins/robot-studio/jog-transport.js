/* Prefer controller-acknowledged WebSocket jogs. Older FluidUI builds expose
   sendCommand (WebSocket queue acceptance) instead; never send motion by HTTP. */
(() => {
  "use strict";
  function create({ call, canSend }) {
    let mode = "unknown",
      generation = 0;
    const unknownMethod = (error, method) =>
      error.message === `Unknown method: ${method}`;
    return {
      get mode() {
        return mode;
      },
      async send(command) {
        const stamp = generation;
        if (!canSend()) return null;
        if (mode !== "legacy") {
          try {
            const result = await call("sendJog", { command });
            mode = "native";
            return result;
          } catch (error) {
            // Unknown method guarantees the bridge did not send this move.
            // A timeout or controller error could follow an accepted move,
            // so those must stop control rather than retry on another API.
            if (!unknownMethod(error, "sendJog")) throw error;
            mode = "legacy";
          }
        }
        // Stop or retarget may arrive while the compatibility probe is pending.
        if (stamp !== generation || !canSend()) return null;
        return call("sendCommand", { command });
      },
      async cancel() {
        generation++;
        await call("sendRealtime", { byte: 0x85 });
        await call("sendRealtime", { byte: 0x3f });
      },
      async end() {
        generation++;
        if (mode === "legacy") return;
        try {
          await call("endJog");
        } catch (error) {
          if (!unknownMethod(error, "endJog")) throw error;
        }
      },
    };
  }
  globalThis.RobotJogTransport = { create };
})();
