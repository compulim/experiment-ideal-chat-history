import { memo } from 'react';
import ChatApp, { CHAT_MESSAGES } from './ChatApp';

export default memo(function App() {
  return <ChatApp messages={CHAT_MESSAGES} />;
});
