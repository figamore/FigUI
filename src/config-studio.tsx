import { createRoot } from "react-dom/client";
import { ConfigStudio } from "./components/ConfigStudio";
import "./config-studio.css";
import {
  STUDIO_API_VERSION,
  type ConfigStudioProps,
  type ConfigStudioInstance,
} from "./lib/configStudioContract";

export const apiVersion = STUDIO_API_VERSION;
export const buildId = __CONFIG_STUDIO_BUILD__;

export function mount(
  target: HTMLElement,
  initialProps: ConfigStudioProps,
): ConfigStudioInstance {
  const root = createRoot(target);
  let props = initialProps;
  const render = () => root.render(<ConfigStudio {...props} />);
  render();

  return {
    update(nextProps) {
      props = nextProps;
      render();
    },
    unmount() {
      root.unmount();
      target.replaceChildren();
    },
  };
}
