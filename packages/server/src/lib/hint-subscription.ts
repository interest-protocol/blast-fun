export type HintSink = Readonly<{
  send(chunk: Uint8Array): boolean;
  close(): void;
}>;

export type HintSubscription = Response | (() => void);
