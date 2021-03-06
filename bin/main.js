#!/usr/bin/env node

var args = require('optimist').argv;
var ircee = require('ircee');
var cp = require('child_process');
var net = require('net');
var through = require('through');

var EventEmitter = require('events').EventEmitter;

var fs = require('fs');
var path = require('path');

function loadConfig(file) {   

    var filepath = path.join(process.cwd(), file || 'config.json');
    if (!fs.existsSync(filepath))
        filepath = path.join(process.cwd(), 'config.json');
    if (!fs.existsSync(filepath))
        filepath = path.join(process.cwd(), 'config.js');

    if (require.cache[filepath]) 
        delete require.cache[filepath]
    
    var config = require(filepath);
    for (var key in args) 
        config[key] = args[key];
    return config;
}

function connection(config) {
    var irc =  ircee(),
        self = new EventEmitter();

    irc.config = config;
    irc.use(require('ircee/core'));

    var instream = through(),
        outstream = through();        
 
    irc.instream = instream;
    irc.outstream = outstream;

    var pings = 0;
    function connect() {
        pings = 0;
        var socket = net.connect(config.port, config.server);
        socket.pipe(instream, {end: false});
        outstream.pipe(socket, {end: false});
        socket.pipe(irc, {end: false}).pipe(socket);
        socket.on('error', function(err) {
            console.log("socket error:", err);
        });
        socket.on('timeout', function() {
            if (++pings > 1) socket.destroy();
            else irc.send('PING', new Date().getTime());
        });
        socket.setTimeout(90 * 1000);
        socket.on('close', function(err) {
            console.log("Connection closed, trying to reconnect");
            setTimeout(connect, irc.config.reconnectDelay * 1000 || 5000);
        });        
    };
    irc.on('pong', function() { --pings; });

    connect();
    return irc;
}

function child(irc) {    

    var ipcadr = '/tmp/triplie-' + process.pid + '.sock';

    var config = loadConfig(args._[0]),
        self = {},
        socket = null,
        ipc = net.createServer(function(cli) {
            console.log("parent: child process connected");
            irc.instream.pipe(cli, {end: false});
            cli.pipe(irc.outstream, {end: false});
        }), child;

    child = run(config);

    ipc.listen(ipcadr);

    irc.on('connect', function() {        
        function childReady(k) {
            if (child) 
                try { return child.send({connection: true});
                } catch (e) {}
            if (k < 10) 
                setTimeout(childReady.bind(null, k+1), 1000); // try again in 1s
        }
        childReady(0);
    }); 

    function run(config) {
        var child = cp.fork(__dirname + '/../lib/child.js');
        child.on('exit', function(c) {
            console.log("Child exit with status code", c);
            if (c) {
                setTimeout(reload, 3000);
            }
        });
        try {
            child.stdout.pipe(process.stdout);
            child.stderr.pipe(process.stderr);        
        } catch (e) { }
        child.on('message', function(msg, handler) {
            if (msg.reload) reload();
            if (msg.save) saveConfig(msg.save);
        });
        child.send({init: true, config: config, ipc: ipcadr });
        return child;
    };

    function reload() {
        try { config = loadConfig(args._[0]); } catch (e) {}
        irc.config = config;
        try { child.kill('SIGKILL'); } 
        catch (e) {}
        child = run(config);
    }

    function saveConfig(data) {
        fs.writeFile(path.join(process.cwd(), args._[0] || 'config.json'), data)
    }

}

child(connection(loadConfig(args._[0])));

