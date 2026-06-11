const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());

const SENHA_ADMIN = process.env.SENHA_ADMIN || 'MINHA_SENHA_123';

// =============================================
// CONEXÃO COM O BANCO POSTGRESQL
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Testar conexão
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Erro ao conectar ao PostgreSQL:', err.message);
    } else {
        console.log('✅ Conectado ao PostgreSQL no Neon');
        release();
    }
});

// =============================================
// FUNÇÕES AUXILIARES
// =============================================
function limparCnpj(cnpj) {
    if (!cnpj) return '';
    return cnpj.replace(/[^0-9]/g, '');
}

function formatarCnpj(cnpj) {
    const numeros = limparCnpj(cnpj);
    if (numeros.length !== 14) return cnpj;
    return numeros.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// =============================================
// ROTA: REGISTRAR EMPRESA
// =============================================
app.post('/registrar', async (req, res) => {
    const { cnpj, razao_social, nome_fantasia, email, telefone, plano, valor_mensal } = req.body;

    const cnpjLimpo = limparCnpj(cnpj);
    const cnpjFormatado = formatarCnpj(cnpjLimpo);

    if (!cnpjLimpo || (!razao_social && !nome_fantasia)) {
        return res.status(400).json({
            erro: 'CNPJ e RAZAO_SOCIAL ou NOME_FANTASIA são obrigatórios'
        });
    }

    try {
        // Verificar se empresa já existe
        const result = await pool.query(
            'SELECT COD_EMP, CNPJ, NOME_FANTASIA, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length > 0) {
            const empresa = result.rows[0];

            // Verificar parcelas pendentes
            const parcelasResult = await pool.query(
                `SELECT COUNT(*) as total FROM PARCELAS 
                 WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
                [empresa.cod_emp]
            );

            const temPendencia = parcelasResult.rows[0].total > 0;
            const liberado = !empresa.bloqueado && !temPendencia;

            return res.json({
                sucesso: true,
                mensagem: 'Empresa já cadastrada',
                cod_emp: empresa.cod_emp,
                liberado: liberado,
                pendente: temPendencia
            });
        }

        // Empresa nova - cadastrar
        const nomeRazaosocial = razao_social || nome_fantasia;
        const nomeFantasiaFinal = nome_fantasia || razao_social;

        const insertResult = await pool.query(
            `INSERT INTO EMPRESAS 
             (CNPJ, RAZAO_SOCIAL, NOME_FANTASIA, EMAIL, TELEFONE, PLANO, VALOR_MENSAL, DATA_CADASTRO, ATIVO, BLOQUEADO) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), TRUE, TRUE) 
             RETURNING COD_EMP`,
            [cnpjFormatado, nomeRazaosocial, nomeFantasiaFinal, email || null, telefone || null, plano || 'MENSAL', valor_mensal || 130.00]
        );

        const codEmp = insertResult.rows[0].cod_emp;

        // Gerar 12 parcelas para o primeiro ano
        const hoje = new Date();
        for (let i = 1; i <= 12; i++) {
            const vencimento = new Date(hoje);
            vencimento.setMonth(hoje.getMonth() + i);
            const dataVencimento = vencimento.toISOString().split('T')[0];

            await pool.query(
                `INSERT INTO PARCELAS (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO) 
                 VALUES ($1, $2, $3, $4, FALSE)`,
                [codEmp, i, valor_mensal || 130.00, dataVencimento]
            );
        }

        console.log(`✅ Nova empresa cadastrada: ${cnpjLimpo} - ${nomeFantasiaFinal}`);

        res.json({
            sucesso: true,
            mensagem: 'Empresa cadastrada com sucesso',
            cod_emp: codEmp,
            liberado: false,
            pendente: true
        });

    } catch (error) {
        console.error('Erro ao registrar empresa:', error);
        res.status(500).json({ erro: 'Erro interno ao cadastrar empresa' });
    }
});

// =============================================
// ROTA: VERIFICAR SE ESTÁ LIBERADO
// =============================================
app.get('/verificar/:cnpj', async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    try {
        const result = await pool.query(
            'SELECT COD_EMP, BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.json({
                liberado: false,
                cadastrado: false,
                mensagem: 'Empresa não cadastrada'
            });
        }

        const empresa = result.rows[0];

        const parcelasResult = await pool.query(
            `SELECT COUNT(*) as total FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
            [empresa.cod_emp]
        );

        const temPendencia = parcelasResult.rows[0].total > 0;
        const liberado = !empresa.bloqueado && !temPendencia;

        res.json({
            liberado: liberado,
            cadastrado: true,
            pendente: temPendencia,
            parcelas_vencidas: parcelasResult.rows[0].total
        });

    } catch (error) {
        console.error('Erro ao verificar:', error);
        res.status(500).json({ erro: 'Erro ao verificar status' });
    }
});

// =============================================
// ROTA: LISTAR TODAS EMPRESAS (ADMIN)
// =============================================
app.get('/empresas', async (req, res) => {
    const senha = req.headers['x-senha'];

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(`
            SELECT 
                E.COD_EMP as "COD_EMP",
                E.CNPJ as "CNPJ",
                E.NOME_FANTASIA as "NOME_FANTASIA",
                E.RAZAO_SOCIAL as "RAZAO_SOCIAL",
                E.EMAIL as "EMAIL",
                E.BLOQUEADO as "BLOQUEADO",
                E.MOTIVO_BLOQUEIO as "MOTIVO_BLOQUEIO",
                E.PLANO as "PLANO",
                E.VALOR_MENSAL as "VALOR_MENSAL",
                TO_CHAR(E.DATA_CADASTRO, 'DD/MM/YYYY') as "DATA_CADASTRO",
                COUNT(P.COD_PAR) as "TOTAL_PARCELAS",
                COUNT(CASE WHEN P.PAGO = TRUE THEN 1 END) as "TOTAL_PAGAS",
                COUNT(CASE WHEN P.PAGO = FALSE AND P.DATA_VENCIMENTO < CURRENT_DATE THEN 1 END) as "VENCIDAS",
                COUNT(CASE WHEN P.PAGO = FALSE AND P.DATA_VENCIMENTO >= CURRENT_DATE THEN 1 END) as "NAO_VENCIDAS"
            FROM EMPRESAS E
            LEFT JOIN PARCELAS P ON E.COD_EMP = P.COD_EMP
            GROUP BY 
                E.COD_EMP, E.CNPJ, E.NOME_FANTASIA, E.RAZAO_SOCIAL, E.EMAIL, 
                E.BLOQUEADO, E.MOTIVO_BLOQUEIO, E.PLANO, E.VALOR_MENSAL, E.DATA_CADASTRO
        `);

        res.json({ empresas: result.rows });

    } catch (error) {
        console.error('Erro ao listar empresas:', error);
        res.status(500).json({ erro: 'Erro ao listar empresas' });
    }
});

// =============================================
// ROTA: LISTAR PARCELAS DE UMA EMPRESA
// =============================================
app.get('/parcelas/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const parcelasResult = await pool.query(
            `SELECT 
                NUMERO_PARCELA as numero_parcela,
                VALOR::DECIMAL(10,2) as valor,
                DATA_VENCIMENTO as data_vencimento,
                DATA_PAGAMENTO as data_pagamento,
                PAGO as pago,
                JUROS::DECIMAL(10,2) as juros,
                MULTA::DECIMAL(10,2) as multa,
                FORMA_PAGAMENTO as forma_pagamento,
                STATUS as status
             FROM PARCELAS 
             WHERE COD_EMP = $1 
             ORDER BY NUMERO_PARCELA ASC`,
            [codEmp]
        );

        console.log(`📦 Parcelas encontradas: ${parcelasResult.rows.length}`);
        res.json({ parcelas: parcelasResult.rows });

    } catch (error) {
        console.error('Erro ao listar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao listar parcelas' });
    }
});

// =============================================
// ROTA: LIBERAR EMPRESA
// =============================================
app.post('/liberar/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = result.rows[0].cod_emp;

        await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = FALSE, MOTIVO_BLOQUEIO = NULL WHERE COD_EMP = $1',
            [codEmp]
        );

        res.json({ liberado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao liberar:', error);
        res.status(500).json({ erro: 'Erro ao liberar empresa' });
    }
});

// =============================================
// ROTA: BLOQUEAR EMPRESA
// =============================================
app.delete('/bloquear/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const result = await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = TRUE, MOTIVO_BLOQUEIO = $1 WHERE CNPJ = $2',
            ['BLOQUEIO_MANUAL', cnpjFormatado]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        res.json({ sucesso: true, bloqueado: true, cnpj: cnpj });

    } catch (error) {
        console.error('Erro ao bloquear:', error);
        res.status(500).json({ erro: 'Erro ao bloquear empresa' });
    }
});

// =============================================
// ROTA: DAR BAIXA EM UMA PARCELA
// =============================================
app.post('/baixar-parcela/:cnpj/:numero', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const numero = parseInt(req.params.numero);
    const { forma_pagamento } = req.body;

    console.log(`📌 Baixar parcela - CNPJ: ${cnpj}, Parcela: ${numero}, Forma: ${forma_pagamento}`);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const result = await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = TRUE, 
                 DATA_PAGAMENTO = CURRENT_DATE, 
                 FORMA_PAGAMENTO = $1,
                 STATUS = 'PAGA'
             WHERE COD_EMP = $2 AND NUMERO_PARCELA = $3`,
            [forma_pagamento, codEmp, numero]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ erro: 'Parcela não encontrada' });
        }

        console.log(`✅ Parcela ${numero} da empresa ${cnpj} recebeu baixa`);
        res.json({ sucesso: true, mensagem: 'Baixa realizada com sucesso' });

    } catch (error) {
        console.error('❌ Erro ao dar baixa:', error);
        res.status(500).json({ erro: 'Erro ao dar baixa na parcela', detalhe: error.message });
    }
});

// =============================================
// ROTA: CANCELAR BAIXA DE UMA PARCELA
// =============================================
app.post('/cancelar-baixa-parcela/:cnpj/:numero', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const numero = parseInt(req.params.numero);

    console.log(`📌 Cancelar baixa - CNPJ: ${cnpj}, Parcela: ${numero}`);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        await pool.query(
            `UPDATE PARCELAS 
             SET PAGO = FALSE, 
                 DATA_PAGAMENTO = NULL, 
                 FORMA_PAGAMENTO = NULL,
                 STATUS = CASE 
                     WHEN DATA_VENCIMENTO < CURRENT_DATE THEN 'ATRASADA'
                     ELSE 'PENDENTE'
                 END
             WHERE COD_EMP = $1 AND NUMERO_PARCELA = $2`,
            [codEmp, numero]
        );

        console.log(`✅ Baixa da parcela ${numero} cancelada com sucesso`);
        res.json({ sucesso: true, mensagem: 'Baixa cancelada com sucesso' });

    } catch (error) {
        console.error('❌ Erro ao cancelar baixa:', error);
        res.status(500).json({ erro: 'Erro ao cancelar baixa', detalhe: error.message });
    }
});

// =============================================
// ROTA: GERAR MÚLTIPLAS PARCELAS
// =============================================
app.post('/gerar-parcelas/:cnpj', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);
    const { parcelas } = req.body;

    console.log(`📌 Gerar parcelas - CNPJ: ${cnpj}`);
    console.log(`📦 Parcelas a gerar: ${parcelas.length}`);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const codEmp = empresaResult.rows[0].cod_emp;

        const maxParcelaResult = await pool.query(
            'SELECT MAX(NUMERO_PARCELA) as max FROM PARCELAS WHERE COD_EMP = $1',
            [codEmp]
        );

        let proximoNumero = (maxParcelaResult.rows[0].max || 0) + 1;
        console.log(`📌 Próximo número de parcela: ${proximoNumero}`);

        let inseridas = 0;
        for (const parcela of parcelas) {
            let status = 'PENDENTE';
            const dataVencimento = new Date(parcela.data_vencimento);
            const hoje = new Date();
            hoje.setHours(0, 0, 0, 0);

            if (parcela.pago) {
                status = 'PAGA';
            } else if (dataVencimento < hoje) {
                status = 'ATRASADA';
            }

            const result = await pool.query(
                `INSERT INTO PARCELAS 
                 (COD_EMP, NUMERO_PARCELA, VALOR, DATA_VENCIMENTO, PAGO, STATUS, FORMA_PAGAMENTO) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [codEmp, proximoNumero, parcela.valor, parcela.data_vencimento, parcela.pago || false, status, null]
            );

            if (result.rowCount > 0) {
                inseridas++;
                proximoNumero++;
            }
        }

        console.log(`✅ Geradas ${inseridas} parcelas para empresa ${cnpj}`);
        res.json({ sucesso: true, mensagem: `${inseridas} parcelas geradas com sucesso` });

    } catch (error) {
        console.error('❌ Erro ao gerar parcelas:', error);
        res.status(500).json({ erro: 'Erro ao gerar parcelas', detalhe: error.message });
    }
});

// =============================================
// ROTA: ALTERNAR BLOQUEIO MANUAL (Toggle)
// =============================================
app.post('/empresa/:cnpj/toggle-bloqueio', async (req, res) => {
    const senha = req.headers['x-senha'];
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    if (senha !== SENHA_ADMIN) {
        return res.status(401).json({ erro: 'Senha inválida' });
    }

    try {
        const empresaResult = await pool.query(
            'SELECT BLOQUEADO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.status(404).json({ erro: 'Empresa não encontrada' });
        }

        const bloqueadoAtual = empresaResult.rows[0].bloqueado === true;
        const novoBloqueio = !bloqueadoAtual;
        const motivo = novoBloqueio ? 'BLOQUEIO_MANUAL_ADMIN' : 'DESBLOQUEIO_MANUAL_ADMIN';

        await pool.query(
            'UPDATE EMPRESAS SET BLOQUEADO = $1, MOTIVO_BLOQUEIO = $2 WHERE CNPJ = $3',
            [novoBloqueio, motivo, cnpjFormatado]
        );

        console.log(`✅ Empresa ${cnpj} - Bloqueio manual: ${novoBloqueio ? 'BLOQUEADA' : 'DESBLOQUEADA'}`);

        res.json({
            sucesso: true,
            bloqueado: novoBloqueio,
            mensagem: novoBloqueio ? 'Empresa bloqueada manualmente' : 'Empresa desbloqueada manualmente'
        });

    } catch (error) {
        console.error('Erro ao alternar bloqueio:', error);
        res.status(500).json({ erro: 'Erro ao alternar bloqueio' });
    }
});

// =============================================
// ROTA: VERIFICAR BLOQUEIO COM TOLERÂNCIA DE 15 DIAS
// =============================================
app.get('/empresa/:cnpj/status-bloqueio', async (req, res) => {
    const cnpj = limparCnpj(req.params.cnpj);
    const cnpjFormatado = formatarCnpj(cnpj);

    console.log(`🔍 Buscando empresa com CNPJ: ${cnpjFormatado}`);

    try {
        const empresaResult = await pool.query(
            'SELECT COD_EMP, BLOQUEADO, MOTIVO_BLOQUEIO FROM EMPRESAS WHERE CNPJ = $1',
            [cnpjFormatado]
        );

        if (empresaResult.rows.length === 0) {
            return res.json({
                cadastrada: false,
                bloqueado: true,
                motivo: 'EMPRESA_NAO_CADASTRADA'
            });
        }

        const empresa = empresaResult.rows[0];

        // PRIORIDADE 1: BLOQUEIO MANUAL
        if (empresa.bloqueado === true) {
            return res.json({
                cadastrada: true,
                bloqueado: true,
                motivo: empresa.motivo_bloqueio || 'BLOQUEIO_MANUAL',
                bloqueio_manual: true,
                pode_desbloquear: true
            });
        }

        // VERIFICAR PARCELAS ATRASADAS
        const parcelasResult = await pool.query(
            `SELECT 
                COUNT(*) as total,
                MIN(DATA_VENCIMENTO) as primeira_vencida
             FROM PARCELAS 
             WHERE COD_EMP = $1 AND PAGO = FALSE AND DATA_VENCIMENTO < CURRENT_DATE`,
            [empresa.cod_emp]
        );

        const temParcelasAtrasadas = parcelasResult.rows[0].total > 0;

        if (!temParcelasAtrasadas) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = NULL, dias_aviso_enviado = 0, data_bloqueio_previsto = NULL WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );
            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'EM_DIA',
                nivel_aviso: 0,
                dias_atraso: 0,
                dias_restantes: 0
            });
        }

        // CALCULAR DIAS DE ATRASO
        const primeiraVencimento = new Date(parcelasResult.rows[0].primeira_vencida);
        const hoje = new Date();
        primeiraVencimento.setHours(0, 0, 0, 0);
        hoje.setHours(0, 0, 0, 0);

        const diasAtraso = Math.floor((hoje - primeiraVencimento) / (1000 * 60 * 60 * 24));

        console.log(`📊 Dias de atraso: ${diasAtraso}`);

        // Dias 1-3: Tolerância (sem aviso)
        if (diasAtraso <= 3) {
            await pool.query(
                'UPDATE EMPRESAS SET dias_aviso_enviado = 0, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'15 days\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'TOLERANCIA_INICIAL',
                nivel_aviso: 0,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso
            });
        }

        // Dias 4-7: Aviso amarelo
        if (diasAtraso >= 4 && diasAtraso <= 7) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = CURRENT_DATE, dias_aviso_enviado = 1, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'8 days\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            const dataBloqueio = new Date();
            dataBloqueio.setDate(dataBloqueio.getDate() + (15 - diasAtraso));

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'AVISO_AMARELO',
                nivel_aviso: 1,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso,
                data_bloqueio_previsto: dataBloqueio.toISOString().split('T')[0]
            });
        }

        // Dias 8-14: Aviso vermelho
        if (diasAtraso >= 8 && diasAtraso <= 14) {
            await pool.query(
                'UPDATE EMPRESAS SET data_ultimo_aviso = CURRENT_DATE, dias_aviso_enviado = 2, data_bloqueio_previsto = CURRENT_DATE + INTERVAL \'1 day\' WHERE COD_EMP = $1',
                [empresa.cod_emp]
            );

            const dataBloqueio = new Date();
            dataBloqueio.setDate(dataBloqueio.getDate() + (15 - diasAtraso));

            return res.json({
                cadastrada: true,
                bloqueado: false,
                motivo: 'AVISO_VERMELHO',
                nivel_aviso: 2,
                dias_atraso: diasAtraso,
                dias_restantes: 15 - diasAtraso,
                data_bloqueio_previsto: dataBloqueio.toISOString().split('T')[0]
            });
        }

        // Dias >= 15: BLOQUEIO EFETIVO
        if (diasAtraso >= 15) {
            await pool.query(
                'UPDATE EMPRESAS SET BLOQUEADO = TRUE, MOTIVO_BLOQUEIO = $1 WHERE COD_EMP = $2',
                ['BLOQUEIO_AUTOMATICO_15_DIAS', empresa.cod_emp]
            );

            return res.json({
                cadastrada: true,
                bloqueado: true,
                motivo: 'BLOQUEIO_AUTOMATICO',
                nivel_aviso: 3,
                dias_atraso: diasAtraso,
                bloqueio_manual: false,
                parcelas_vencidas: parcelasResult.rows[0].total
            });
        }

        return res.json({
            cadastrada: true,
            bloqueado: false,
            motivo: 'VERIFICADO',
            nivel_aviso: 0,
            dias_atraso: diasAtraso,
            dias_restantes: 15 - diasAtraso
        });

    } catch (error) {
        console.error('Erro ao verificar status:', error);
        res.status(500).json({ erro: 'Erro ao verificar status' });
    }
});

// =============================================
// ROTA INICIAL
// =============================================
app.get('/', (req, res) => {
    res.json({
        api: "API Desbloqueio - Funcionando com PostgreSQL!",
        status: "online",
        versao: "2.0.0"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 API rodando na porta ${PORT} com PostgreSQL`);
});