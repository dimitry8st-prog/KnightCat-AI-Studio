const parsed = $('Parse and Validate Package').first().json;
return [{ json: {
  chat_id: parsed.reply_chat_id,
  user_message: 'Не удалось скачать фотографию из сообщения. Черновик не сохранён, публикация не запускалась.'
}}];
