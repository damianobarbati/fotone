import type React from 'react';
import favicon from './assets/logo-on-light.svg?inline';
import './index.css';

type LayoutProps = { children: React.ReactNode };

export const Layout = ({ children }: LayoutProps) => {
  const result = (
    <>
      <link rel="icon" type="image/svg+xml" href={favicon} />
      {children}
    </>
  );

  return result;
};
