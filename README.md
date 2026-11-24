# Meu Controle Financeiro
Aplicativo pessoal PWA para instalação no iPhone pela tela inicial.

## Recursos da primeira versão
- Receitas e despesas manuais, com data e categoria
- Resumo mensal de saldo, receitas e despesas
- Meta de economia configurável (padrão 15%)
- Dados locais criptografados com AES-GCM e chave derivada da senha
- Exportação e restauração de backup criptografado
- Cache para uso offline após a primeira abertura online

## Publicar pelo GitHub Pages
1. Envie todos os arquivos desta pasta para a raiz do repositório `Meu-controle-financeiro` (não envie a pasta compactada como único arquivo).
2. No GitHub, abra **Settings → Pages**.
3. Em **Build and deployment**, selecione **Deploy from a branch**.
4. Escolha a branch **main** e a pasta **/(root)** e salve.
5. Aguarde o endereço HTTPS aparecer na página Pages.
6. Abra o endereço no Safari do iPhone, toque em Compartilhar e escolha **Adicionar à Tela de Início**.

## Importante
O aplicativo precisa ser aberto online uma primeira vez para baixar os arquivos e ativar o modo offline. Os lançamentos ficam no armazenamento local do navegador, não no GitHub. Faça backups criptografados regularmente. Se apagar os dados do Safari ou trocar de aparelho, restaure um backup. Teste backup e restauração antes de usar com dados importantes.
