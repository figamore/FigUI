import mainConfig from "./tailwind.config.js";

export default {
  ...mainConfig,
  content: ["./src/components/ConfigStudio.tsx", "./src/config-studio.tsx"],
};
