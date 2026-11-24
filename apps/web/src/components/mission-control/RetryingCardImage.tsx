"use client";

import Image, { type ImageProps } from "next/image";
import { useEffect, useRef, useState } from "react";

import { cardImageRetryDelayMs, cardImageRetrySrc } from "./card-image-retry.ts";

type RetryingCardImageProps = Omit<ImageProps, "alt" | "src" | "onError"> & {
  alt: string;
  src: string;
  /** Called when a load failed and another attempt is scheduled. */
  onRetrying?: () => void;
  /** Called once every retry has failed. */
  onGiveUp?: () => void;
};

/** A card image that retries while the server is still drawing the card. */
export function RetryingCardImage({ alt, src, onRetrying, onGiveUp, ...props }: RetryingCardImageProps) {
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Image
      {...props}
      alt={alt}
      key={attempt}
      src={cardImageRetrySrc(src, attempt)}
      onError={() => {
        failures.current += 1;
        const wait = cardImageRetryDelayMs(failures.current);
        if (wait === null) {
          onGiveUp?.();
          return;
        }
        onRetrying?.();
        timer.current = setTimeout(() => setAttempt((value) => value + 1), wait);
      }}
    />
  );
}
