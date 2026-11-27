import type React from 'react';
import './index.css';

type LayoutProps = { children: React.ReactNode };

export const Layout = ({ children }: LayoutProps) => {
  const result = (
    <>
      <link rel="icon" type="image/svg+xml" href={`${import.meta.env.BASE_URL}logo.svg`} />
      {children}
    </>
  );

  return result;
};
