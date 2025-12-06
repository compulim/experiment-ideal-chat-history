import type { ReactNode } from 'react';

export type Message = {
  readonly abstract: string;
  readonly children: ReactNode | undefined;
  readonly id: string;
};
