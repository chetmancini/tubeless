declare global {
  namespace JSX {
    interface IntrinsicElements {
      status: { value: string };
    }
  }
}

export const element = <status value="ready" />;
