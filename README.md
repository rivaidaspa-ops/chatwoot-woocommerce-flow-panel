# Panel Chatwoot WooCommerce Multi-país v8.3

Actualización v8.3:

- Asistente de venta cambia automáticamente por país: Chile o Colombia.
- Prompts IA configurables por país desde Credenciales.
- Soporte para OpenAI/ChatGPT, DeepSeek, Gemini y webhook personalizado.
- Recomendaciones usan métodos de pago y envío disponibles desde WooCommerce.
- Generador de cupón recomendado según país, carrito, pago y envío.
- Mantiene RUT AliDropship Chile, ciudades/departamentos Dropi Colombia, códigos postales, stock primero y bloqueo de variaciones sin stock.

Subir:

```bash
git add -A
git commit -m "Upgrade v8.3 country sales assistant AI prompts and coupon generator"
git push
```

EasyPanel: Dockerfile, puerto 3001, variables mínimas iguales a v8.x. Las credenciales se administran desde el modal Credenciales.
