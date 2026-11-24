"use client";

import { INITIAL_CREATE_STATE } from "./create-store";
import { CreateView } from "./CreateView";

const ignore = () => {};

export function CreateLoading() {
  return <CreateView state={INITIAL_CREATE_STATE} onLogo={ignore} onList={ignore} onRetry={ignore} signIn={null} />;
}
