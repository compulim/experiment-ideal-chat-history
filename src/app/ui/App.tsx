import { memo, useEffect, useState, type ReactNode } from 'react';
import type { Message } from '../types';
import AddressForm from './AddressForm';
import ChatApp from './ChatApp';

function Attachment({ children }: { children?: ReactNode | undefined }) {
  return (
    <div role="group">
      <div>{children}</div>
    </div>
  );
}

const CHAT_MESSAGES: readonly Message[] = Object.freeze([
  {
    // "abstract" can be built using a new "activity abstract middleware". Not sure if we should support React elements or just plain text.
    abstract: 'Bot said: Hello, World!',
    children: (
      <>
        <p>Hello, World!</p>
        <p>
          Click <a href="https://bing.com/">this link</a> for more details.
        </p>
      </>
    ),
    id: 'a-00001'
  },
  {
    abstract: 'You said: Aloha!',
    children: <p>Aloha!</p>,
    id: 'a-00002'
  },
  {
    abstract: 'Bot said: Where should we ship it to? Has an attachment.',
    children: (
      <>
        <p>Where should we ship it to?</p>
        <Attachment>
          <AddressForm />
        </Attachment>
      </>
    ),
    id: 'a-00003'
  }
]);

export default memo(function App() {
  const [messages, setMessages] = useState<readonly Message[]>(() => CHAT_MESSAGES);

  useEffect(() => {
    window.addEventListener(
      'addmessage',
      () => {
        setMessages(messages =>
          Object.freeze([
            ...messages,
            {
              abstract: 'Bot said: Thank you.',
              children: <p>Thank you.</p>,
              id: 'a-00004'
            }
          ])
        );
      },
      { once: true }
    );
  }, []);

  return <ChatApp messages={messages} />;
});
