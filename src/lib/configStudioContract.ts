import type { FluidConfig } from "./fluidSchema";

// Bump when the host/module interface changes incompatibly.
export const STUDIO_API_VERSION = 1;

export type ConfigStudioProps = {
  content: string;
  onChange: (yaml: string) => void;
  isActive: boolean;
  firmwareVersion?: string | null;
  loadConfig: (firmwareVersion?: string | null) => Promise<FluidConfig | null>;
};

export type ConfigStudioInstance = {
  update: (props: ConfigStudioProps) => void;
  unmount: () => void;
};

export type ConfigStudioModule = {
  apiVersion: number;
  buildId: string;
  mount: (
    target: HTMLElement,
    props: ConfigStudioProps,
  ) => ConfigStudioInstance;
};
