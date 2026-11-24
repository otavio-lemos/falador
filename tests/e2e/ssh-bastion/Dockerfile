FROM alpine:3.20

RUN apk add --no-cache openssh-server coreutils bash \
    && ssh-keygen -A \
    && mkdir -p /root/.ssh \
    && chmod 700 /root/.ssh

# Configuração do sshd: chave pública ed25519, bastion forwarding (-J), StrictModes desativado para volumes montados
RUN printf '%s\n' \
    'Port 22' \
    'PermitRootLogin yes' \
    'PubkeyAuthentication yes' \
    'PasswordAuthentication no' \
    'AllowTcpForwarding yes' \
    'GatewayPorts yes' \
    'StrictModes no' \
    'AuthorizedKeysFile /root/.ssh/authorized_keys' \
    'HostKey /etc/ssh/ssh_host_ed25519_key' \
    'Subsystem sftp internal-sftp' \
    > /etc/ssh/sshd_config

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
