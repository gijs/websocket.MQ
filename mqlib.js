
var sys = require('sys');
var fs = require('fs');

var sRegSvc;
var sMainDir;
var sTempDir;
var sMsgCacheMax = 100000;
var sQuietHoursMax = 28;
var sQuietCleanPeriod = 20*1000;
var sBytesPerMs = 1000/8;

var sQueues = {}; // array objects indexed by nodeid
var sPending = {}; // pending message counts indexed by uid
var sActive = {}; // connections indexed by nodeid
var sSingleNodeMsg = {}; // queues sending a single-node message, indexed by message id
var sShutdown = false;


module.exports.init = function(iMainDir, iRegSvc) {
  sMainDir = iMainDir+'/';
  sTempDir = sMainDir+'temp/';
  sRegSvc = iRegSvc;

  try {
  fs.mkdirSync(sMainDir, 0700);
  } catch (err) {
    if (err.errno !== process.EEXIST) throw err;
  }
  try {
  fs.mkdirSync(sTempDir, 0700);
  } catch (err) {
    if (err.errno !== process.EEXIST) throw err;
  }
};

module.exports.quit = function() {
  sShutdown = true;
  sQuiet.stopClean();
  for (var a in sActive)
    sActive[a].conn.close();
};

module.exports.Link = Link;

module.exports.packMsg = packMsg; // for in-process testing


function storeFile(iPath, iBuf, iCallback) {
  fs.open(iPath, 'w', 0600, function(err, fd) {
    if (err)
      return iCallback(err);
    fWrite(iBuf);
    function fWrite(buf) {
      fs.write(fd, buf, 0, buf.length, null, function(err, written) {
        if (err) {
          fs.close(fd);
          return iCallback(err);
        }
        if (written < buf.length)
          return fWrite(buf.slice(written));
        fs.fsync(fd, function(err) {
          fs.close(fd);
          iCallback(err);
        });
      });
    }
  });
}

function syncFile(iPath, iCallback) {
  fs.open(iPath, 'r', function(err, fd) {
    if (err) return iCallback(err);
    fs.fsync(fd, function(err) {
      fs.close(fd, noop);
      iCallback(err);
    });
  });
}

function packMsg(iJso, iData) {
  var aEtc = 'etc' in iJso && typeof iJso.etc !== 'number' ? JSON.stringify(iJso.etc) : '';
  if (aEtc.length)
    iJso.etc = aEtc.length;
  var aReq = JSON.stringify(iJso);
  var aLen = (aReq.length.toString(16)+'   ').slice(0,4);
  var aBuf = new Buffer(aLen.length + aReq.length + aEtc.length + (iData ? iData.length : 0));
  aBuf.write(aLen, 0);
  aBuf.write(aReq, aLen.length);
  aBuf.write(aEtc, aLen.length + aReq.length);
  if (iData)
    iData.copy(aBuf, aLen.length + aReq.length + aEtc.length, 0);
  return aBuf;
}

function getPath(iNode) {
  return sMainDir + iNode.slice(0, 4).toLowerCase() +'/'+ iNode.toLowerCase();
}

function getSub(iNode) {
  return sMainDir + iNode.slice(0, 4).toLowerCase();
}

function noop(err) { if (err) throw err; }


var sLock = {
  rsrc: {}
};

  sLock.read  = function(iId, iFn) { return this._lock(iId, iFn, 'read', 'write') };
  sLock.write = function(iId, iFn) { return this._lock(iId, iFn, 'write', 'read') };

  sLock._lock = function(iId, iFn, iA, iB) {
    if (!this.rsrc[iId])
      this.rsrc[iId] = {};
    if (!this.rsrc[iId][iB]) {
      if (!this.rsrc[iId][iA])
        this.rsrc[iId][iA] = 0;
      ++this.rsrc[iId][iA];
      return true;
    }
    if (!this.rsrc[iId].queue)
      this.rsrc[iId].queue = [];
    this.rsrc[iId].queue.push(iFn);
    return false;
  };

  sLock.free = function(iId) {
    var aType = this.rsrc[iId].read ? 'read' : 'write';
    if (--this.rsrc[iId][aType] > 0)
      return;
    if (this.rsrc[iId].queue) {
      for (var a=0; a < this.rsrc[iId].queue.length; ++a)
        this.rsrc[iId].queue[a]();
      delete this.rsrc[iId].queue;
    } else {
      delete this.rsrc[iId];
    }
  };


function _root(iId)     { return iId.slice(-3) === 'one' ? iId.slice(0,-3) : iId }
function _isSingle(iId) { return iId.slice(-3) === 'one' }

function _sendNext(iNode) {
  if (!(iNode in sActive) || sQueues[iNode].length === 0)
    return;
  var aN = sQueues[iNode].next;
  if (!sQueues[iNode][aN]) sys.debug(sys.inspect(sQueues[iNode])+' queue '+iNode+' n '+aN+' len '+sQueues[iNode].length);
  var aLn = sActive[iNode];
  var aId = sQueues[iNode][aN];
  sMsgCache.get(iNode, _root(aId), function(msg) {
    if (!msg && sQueues[iNode][aN] === aId) throw new Error('null msg for '+iNode+' '+aId);
    if (sActive[iNode] !== aLn || sQueues[iNode][aN] !== aId)
      return;
    if (_isSingle(aId) && sQueues[iNode].tries === 0) {
      if (msg.length === 0)
        return process.nextTick(function() { deQueueItem(iNode, _root(aId)) });
      if (_root(aId)+'_'+sQueues[iNode].uid in sSingleNodeMsg)
        return sQueues[iNode].timer = setTimeout(_sendNext, msg.length/sBytesPerMs+10, iNode);
      sSingleNodeMsg[_root(aId)+'_'+sQueues[iNode].uid] = iNode;
    }
    ++sQueues[iNode].tries;
    sActive[iNode].conn.write(1, 'binary', msg, function(type) {
      if (sActive[iNode] !== aLn || sQueues[iNode][aN] !== aId)
        return;
      sQueues[iNode].timer = setTimeout(_sendNext, 10*1000, iNode);
    });
  });
}

function _newQueue(iUid, ioArray, iPrior) {
  ioArray.sort();
  for (var a=0; a < ioArray.length; ++a)
    sMsgCache.link(_root(ioArray[a]));
  ioArray.timer = null;
  ioArray.tries = 0;
  ioArray.next = 0;
  ioArray.quiet = iPrior.quiet;
  ioArray.uid = iUid;
  if (!sPending[iUid])
    sPending[iUid] = { q:0, m:{} };
  ++sPending[iUid].q;
  return ioArray;
}

function deleteQueue(iNode) {
  if (sQueues[iNode].timer)
    throw new Error('delete of active queue');
  if (sQueues[iNode].length === 0)
    fs.rmdir(getPath(iNode), function(err) {
      if (err && err.errno !== process.ENOENT) throw err;
    });
  for (var a=0; a < sQueues[iNode].length; ++a)
    if (sQueues[iNode][a])
      sMsgCache.unlink(_root(sQueues[iNode][a]));
  if (--sPending[sQueues[iNode].uid].q === 0)
    delete sPending[sQueues[iNode].uid];
  delete sQueues[iNode];
}

function addPending(iUid, iId) {
  if (sPending[iUid])
    sPending[iUid].m[iId] = true;
}

function delPending(iUid, iId) {
  if (sPending[iUid])
    delete sPending[iUid].m[iId];
}

function startQueue(iNode, iUid, iQuiet) {
  if (!sQueues[iNode]) {
    sQueues[iNode] = { };
    if (sLock.read(iNode, fRead))
      fRead();
    function fRead() {
      fs.readdir(getPath(iNode), function(err, array) {
        if (err && err.errno !== process.ENOENT) throw err;
        sQueues[iNode] = _newQueue(iUid, array || [], sQueues[iNode]);
        if (iQuiet && !(iNode in sActive) && !sQueues[iNode].quiet)
          sQueues[iNode].quiet = sQuiet.append(iNode);
        else
          _sendNext(iNode);
        sLock.free(iNode);
      });
    }
    return;
  }
  if (sQueues[iNode].quiet) {
    sQuiet.remove(sQueues[iNode].quiet);
    sQueues[iNode].quiet = null;
  }
  if ('tries' in sQueues[iNode])
    _sendNext(iNode);
}

function stopQueue(iNode) {
  var aId = sQueues[iNode].length ? sQueues[iNode][sQueues[iNode].next] : '';
  if (_isSingle(aId) && sSingleNodeMsg[_root(aId)+'_'+sQueues[iNode].uid] === iNode) {
    sQueue[iNode].tries = 0;
    delete sSingleNodeMsg[_root(aId)+'_'+sQueues[iNode].uid];
  }
  if (sQueues[iNode].timer) {
    clearTimeout(sQueues[iNode].timer);
    sQueues[iNode].timer = null;
  }
  sQueues[iNode].quiet = sQuiet.append(iNode);
}

function queueItem(iNode, iId, iToType, iCallback) {
  if (!sLock.write(iNode, function(){queueItem(iNode, iId, iToType, iCallback)}))
    return;
  fs.mkdir(getSub(iNode), 0700, function(errSub) {
    if (errSub && errSub.errno !== process.EEXIST) throw errSub;
    fs.mkdir(getPath(iNode), 0700, function(errNode) {
      if (errNode && errNode.errno !== process.EEXIST) throw errNode;
      var aQid = iId + (iToType === 0 ? 'one' : '');
      fs.link(sTempDir+iId, getPath(iNode)+'/'+aQid, function(err) {
        if (err) throw err;
        if (sQueues[iNode] && 'tries' in sQueues[iNode]) {
          sMsgCache.link(iId);
          sQueues[iNode].push(aQid);
          if (sQueues[iNode].pending) {
            delete sQueues[iNode].pending[iId];
            for (var any in sQueues[iNode].pending) break;
            if (!any) {
              _copyQueue(iNode, sQueues[iNode].newNode, sQueues[iNode].onCopy);
              delete sQueues[iNode].pending;
              delete sQueues[iNode].newNode;
            }
          }
          if (sQueues[iNode].tries === 0)
            _sendNext(iNode);
        }
        sLock.free(iNode);
        if (!errSub) syncFile(sMainDir, fDone);
        if (!errNode) syncFile(getSub(iNode), fDone);
        syncFile(getPath(iNode), fDone);
        function fDone(err) {
          if (err) throw err;
          if (!errSub) errSub = true;
          else if (!errNode) errNode = true;
          else iCallback();
        }
      });
    });
  });
}

function deQueueItem(iNode, iId) {
  if (!sQueues[iNode] || !sQueues[iNode].length || _root(sQueues[iNode][sQueues[iNode].next]) !== iId)
    return;
  var aPath = getPath(iNode)+'/'+sQueues[iNode][sQueues[iNode].next];
  if (_isSingle(sQueues[iNode][sQueues[iNode].next]) && sSingleNodeMsg[iId+'_'+sQueues[iNode].uid] === iNode) {
    sMsgCache.zero(iId);
    delete sSingleNodeMsg[iId+'_'+sQueues[iNode].uid];
    fs.open(aPath, 'w', 0600, function(err, fd) {
      if (err) throw err;
      fs.close(fd, function(err) {
        if (err) throw err;
        fs.unlink(aPath, noop);
      });
    });
  } else {
    fs.unlink(aPath, noop);
  }
  sMsgCache.unlink(iId);
  sQueues[iNode][sQueues[iNode].next] = null;
  sQueues[iNode].tries = 0;
  if (sQueues[iNode].timer) {
    clearTimeout(sQueues[iNode].timer);
    sQueues[iNode].timer = null;
  }
  if (++sQueues[iNode].next < sQueues[iNode].length)
    _sendNext(iNode);
  else
    sQueues[iNode].next = sQueues[iNode].length = 0;
}

function copyQueue(iUid, iNode, iNewNode, iCallback) {
  if (!sQueues[iNode] || !('tries' in sQueues[iNode]) || sQueues[iNode].onCopy) {
    if (!sQueues[iNode])
      startQueue(iNode, iUid, 'quiet');
    setTimeout(copyQueue, 100, iUid, iNode, iNewNode, iCallback);
    return;
  }
  for (var any in sPending[sQueues[iNode].uid].m) break;
  if (!any && !sQueues[iNode].length) {
    process.nextTick(iCallback);
  } else if (any) {
    sQueues[iNode].pending = {};
    for (var a in sPending[sQueues[iNode].uid].m)
      sQueues[iNode].pending[a] = true;
    sQueues[iNode].newNode = iNewNode;
    sQueues[iNode].onCopy = fDone;
  } else {
    sQueues[iNode].onCopy = true;
    _copyQueue(iNode, iNewNode, fDone);
  }
  function fDone() {
    delete sQueues[iNode].onCopy;
    iCallback();
  }
}

function _copyQueue(iNode, iNewNode, iCallback) {
  fs.mkdir(getSub(iNewNode), 0700, function(errSub) {
    if (errSub && errSub.errno !== process.EEXIST) throw errSub;
    fs.mkdir(getPath(iNewNode), 0700, function(errNode) {
      if (errNode && errNode.errno !== process.EEXIST) throw errNode;
      // if dir exists, may contain links from previous attempt
      for (var aN=sQueues[iNode].next; aN < sQueues[iNode].length; ++aN)
        fs.link(getPath(iNode)+'/'+sQueues[iNode][aN], getPath(iNewNode)+'/'+sQueues[iNode][aN], fLinked);
      aN = sQueues[iNode].length - sQueues[iNode].next;
      if (aN === 0)
        iCallback();
      function fLinked(err) {
        if (err && err.errno !== process.EEXIST && err.errno !== process.ENOENT) throw err;
        if (--aN > 0)
          return;
        if (!errSub) syncFile(sMainDir, fDone);
        if (!errNode) syncFile(getSub(iNewNode), fDone);
        syncFile(getPath(iNewNode), fDone);
        function fDone(err) {
          if (err) throw err;
          if (!errSub) errSub = true;
          else if (!errNode) errNode = true;
          else iCallback();
        }
      }
    });
  });
}


function LList() {
  this.head = null;
  this.tail = null;
}

  LList.prototype.append = function(iObj) {
    iObj._prev = this.tail;
    iObj._next = null;
    if (this.tail)
      this.tail = this.tail._next = iObj;
    else
      this.head = this.tail = iObj;
  };

  LList.prototype.remove = function(iItem) {
    if (iItem._prev)
      iItem._prev._next = iItem._next;
    if (iItem._next)
      iItem._next._prev = iItem._prev;
    if (iItem === this.head)
      this.head = iItem._next;
    if (iItem === this.tail)
      this.tail = iItem._prev;
    delete iItem._prev;
    delete iItem._next;
  };


var sQuiet = {  // Linked list of inactive queues
  list: new LList(),
  timer: null
};

  sQuiet.append = function(iNode) {
    var aI = { node:iNode, lastOn:Date.now() };
    this.list.append(aI);
    if (!this.timer)
      this.timer = setTimeout(function(){sQuiet._clean()}, sQuietCleanPeriod);
    return aI;
  };

  sQuiet.remove = function(iItem) {
    this.list.remove(iItem);
    if (!this.list.head) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  };

  sQuiet.stopClean = function() {
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = true;
  };

  sQuiet._clean = function() {
    var aCutoff = Date.now() - 15*1000; /// sQuietHoursMax * 60*60*1000;
    while (this.list.head && this.list.head.lastOn < aCutoff) {
      deleteQueue(this.list.head.node);
      this.list.remove(this.list.head);
    }
    this.timer = this.list.head ? setTimeout(function(){sQuiet._clean()}, sQuietCleanPeriod) : null;
  };


var sMsgCache = {
  cache: {}, // indexed by file id
  list: new LList(), // ordered by add order
  size: 0
};

  sMsgCache.get = function(iNode, iId, iCallback) {
    if (this.cache[iId].msg) {
      var aMsg = this.cache[iId].msg;
      process.nextTick(function() { iCallback(aMsg) });
      return;
    }
    if (this.cache[iId].wait) {
      this.cache[iId].wait[iNode] = iCallback;
      return;
    }
    this.cache[iId].wait = {};
    this.cache[iId].wait[iNode] = iCallback;
    var aWait = this.cache[iId].wait;
    fRead(iNode);
    function fRead(queue) {
      fs.readFile(getPath(queue)+'/'+iId, function(err, data) {
        if (err && err.errno !== process.ENOENT) throw err;
        if (!(iId in sMsgCache.cache)) {
          for (var a in aWait)
            aWait[a](null);
          return;
        }
        if (err) {
          aWait[queue](null);
          delete aWait[queue];
          for (var a in aWait)
            return fRead(a);
        } else {
          sMsgCache._put(iId, data);
          for (var a in aWait)
            aWait[a](data);
        }
        delete sMsgCache.cache[iId].wait;
      });
    }
  };

  sMsgCache.add = function(iId, iMsg) {
    if (iId in this.cache) throw new Error('item already in cache');
    this.cache[iId] = { count:0, msg:null };
    this._put(iId, iMsg);
  };

  sMsgCache._put = function(iId, iMsg) {
    if (iMsg.length > sMsgCacheMax/10)
      return;
    this.cache[iId].msg = iMsg;
    this.list.append(this.cache[iId]);
    this.size += iMsg.length;
    if (this.size > sMsgCacheMax)
      process.nextTick(function() { sMsgCache.clean() });
  };

  sMsgCache.zero = function(iId) {
    if (!this.cache[iId].msg)
      return;
    this.size -= this.cache[iId].msg.length;
    this.cache[iId].msg = new Buffer(0);
  };

  sMsgCache.link = function(iId) {
    if (iId in this.cache)
      ++this.cache[iId].count;
    else
      this.cache[iId] = { count:1, msg:null };
  };

  sMsgCache.unlink = function(iId) {
    if (--this.cache[iId].count > 0)
      return;
    if (this.cache[iId].msg) {
      this.size -= this.cache[iId].msg.length;
      this.list.remove(this.cache[iId]);
    }
    delete this.cache[iId];
  };

  sMsgCache.clean = function() {
    while (this.list.head && this.size > sMsgCacheMax) {
      this.size -= this.list.head.msg.length;
      this.list.head.msg = null;
      this.list.remove(this.list.head);
    }
  };


// Connection handler
function Link(iConn) {
  this.conn = iConn;
  this.uid = null;
  this.node = null;
  this.loginTimer = setTimeout(function(that) {
    that.loginTimer = null;
    that.conn.write(1, 'binary', packMsg({op:'quit', info:'close timeout'}));
    that.conn.close();
  }, 6000, this);
}

  Link.prototype.kParams = {
    register: { userId:'string', newNode:'string', aliases:'string' },
    addNode:  { userId:'string', newNode:'string', prevNode:'string' },
    login:    { userId:'string', nodeId:'string' },
    listEdit: { id:'string', to:'string', type:'string', member:'string' },
    //listRenew:{ id:'string', to:'string', list:'object' },
    post:     { id:'string', to:'object' },
    ping:     { id:'string', alias:'string' },
    ack:      { id:'string', type:'string' }
  };

  Link.prototype.kQueueOp = { register:'registered', listEdit:'listEdited', ping:'deliver', post:'deliver' };

  Link.prototype.handleMessage = function(iMsg) {
    try {

    if (!this.conn)
      throw 'message arrived on closed connection';

    var aJsEnd = parseInt(iMsg.toString('ascii', 0, 4), 16) +4;
    if (aJsEnd === NaN || aJsEnd < 4 || aJsEnd > iMsg.length)
      throw 'invalid length header';

    var aReq = JSON.parse(iMsg.toString('ascii', 4, aJsEnd));

    if (typeof aReq.op !== 'string' || typeof this.kParams[aReq.op] === 'undefined')
      throw 'invalid request op';

    if (!this.node && aReq.op !== 'register' && aReq.op !== 'login' && aReq.op !== 'addNode')
      throw 'illegal op on unauthenticated socket';

    for (var a in this.kParams[aReq.op])
      if (typeof aReq[a] !== this.kParams[aReq.op][a])
        throw aReq.op+' request missing param '+a;

    if (aReq.op !== 'listEdit' && aReq.op !== 'post' && aReq.op !== 'ping' && iMsg.length > aJsEnd)
      throw 'message body disallowed for '+aReq.op;

    var aBuf = iMsg.length > aJsEnd ? iMsg.slice(aJsEnd, iMsg.length) : null;

    this['handle_'+aReq.op](aReq, aBuf);
    console.log(aReq);

    } catch (err) {
      if (!this.conn)
        return;
      this.conn.write(1, 'binary', packMsg({op:'quit', info:err.message || err}));
      this.conn.close();
    }
  };

  Link.prototype.handle_register = function(iReq) {
    var that = this;
    sRegSvc[this.node ? 'reregister' : 'register'](iReq.userId, iReq.newNode, null, iReq.aliases, function(err, aliases) {
      if (!that.node || err) {
        if (that.conn)
          that.conn.write(1, 'binary', packMsg({op:'registered', etc:aliases, error:err ? err.message : undefined}));
        return;
      }
      var aTo = {};
      aTo[that.uid] = 1;
      that._postSend({op:'register', to:aTo, etc:aliases}, null, null, function(err, toErr) {
        if ((err || toErr) && that.conn)
          that.conn.write(1, 'binary', packMsg({op:'registered', error: err ? err.message : toErr}));
      });
    });
  };

  Link.prototype.handle_addNode = function(iReq) {
    var that = this;
    if (!iReq.newNode) {
      that.conn.write(1, 'binary', packMsg({op:'added', error:'new nodename required'}));
      return;
    }
    var aThatNode = that.node;
    var aThatUid = that.uid || iReq.userId;
    if (!that.node)
      sRegSvc.verify(iReq.userId, iReq.prevNode, function(err, offset) {
        if (err) {
          if (that.conn)
            that.conn.write(1, 'binary', packMsg({op:'added', error:err.message}));
          return;
        }
        aThatNode = aThatUid+','+offset;
        fCopy();
      });
    else
      fCopy();
    function fCopy() {
      sRegSvc.reregister(aThatUid, iReq.newNode, iReq.prevNode, null, function(err, ignore, offset) {
        if (offset)
          copyQueue(aThatUid, aThatNode, aThatUid+','+offset, fRespond);
        else
          fRespond();
        function fRespond() {
          if (that.conn)
            that.conn.write(1, 'binary', packMsg({op:'added', offset:offset, error: err ? err.message : undefined}));
        }
      });
    }
  };

  Link.prototype.handle_login = function(iReq) {
    var that = this;
    clearTimeout(that.loginTimer);
    that.loginTimer = null;
    sRegSvc.verify(iReq.userId, iReq.nodeId, function(err, offset) {
      if (!that.conn)
        return;
      var aNode = iReq.userId+','+offset;
      var aErr = err ? err.message : aNode in sActive ? 'node already active' : sShutdown ? 'shutdown' : null;
      if (aErr) {
        that.conn.write(1, 'binary', packMsg({op:'quit', info:aErr}));
        that.conn.close();
        return;
      }
      that.uid = iReq.userId;
      that.node = aNode;
      sActive[aNode] = that;
      that.conn.write(1, 'binary', packMsg({op:'info', info:'ok login'}));
      startQueue(that.node, that.uid);
    });
  };

  Link.prototype.handle_listEdit = function(iReq, iBuf) {
    var that = this;
    var aListMsg = {list:iReq.to, op:iReq.type, date:(new Date).toISOString()};
    switch (iReq.type) {
    case 'invite':
      aListMsg.alias = iReq.member;
      sRegSvc.listInvite(iReq.to, this.uid, iReq.member, function(err, uid) {
        if (err) return fComplete(err);
        var aTo = {};
        aTo[uid] = 1;
        that._postSend({op:'post', to:aTo, etc:iReq.etc, noNodes:1}, iBuf, null, fComplete);
      });
      break;
    case 'add':
      aListMsg.uid = iReq.member;
      sRegSvc.listAdd(iReq.to, this.uid, iReq.member, function(err, alias) {
        aListMsg.alias = alias;
        fComplete(err);
      });
      break;
    case 'remove':
      aListMsg.uid = iReq.member;
      sRegSvc.listRemove(iReq.to, this.uid, iReq.member, fComplete);
      break;
    default:
      fComplete(new Error('invalid listEdit type: '+iReq.type));
    }
    function fComplete(err, toErr) {
      if (err || toErr) {
        that._ack(iReq.id, err, toErr);
        return;
      }
      var aTo = {};
      aTo[iReq.to] = 3;
      that.handle_post({op:'listEdit', id:iReq.id, to:aTo, etc:aListMsg}, null);
    }
  };

  Link.prototype._ack = function(iId, iErr, iToErr) {
    if (this.conn)
      this.conn.write(1, 'binary', packMsg({op:'ack', id:iId, type: iErr ? 'error' : 'ok', error: iErr ? iErr.message : iToErr}));
  };

  Link.prototype.sLastId = 0;
  Link.prototype.sLastSubId = 1000;

  Link.prototype._makeId = function() {
    var aId = Date.now();
    if (aId < this.sLastId)
      console.log('system clock went backwards by '+(this.sLastId-aId)+' ms');
    if (this.sLastSubId === 9999)
      throw new Error('queue id suffix maxed out');
    if (aId <= this.sLastId)
      return aId +'-'+ ++this.sLastSubId;
    this.sLastId = aId;
    this.sLastSubId = 1000;
    return aId+'-0';
  };

  Link.prototype.handle_post = function(iReq, iBuf) {
    var that = this;
    var aPoCount = 0, aLsCount = 0, aLsErr, aPoErr;
    for (var a in iReq.to) {
      iReq.to[a] = +iReq.to[a];
      if (iReq.to[a] === 0) {
        delete iReq.to[a];
        ++aPoCount;
        var aTo = {};
        aTo[a] = 0;
        that._postSend({op:'post', to:aTo, etc:iReq.etc, noNodes:1}, iBuf, null, fAck);
      } else if (iReq.to[a] === 2 || iReq.to[a] === 3) {
        ++aLsCount;
        sRegSvc.listLookup(a, that.uid, fAddList);
      }
    }
    if (aLsCount === 0)
      fPostCommon();

    function fAddList(err, list, members) {
      if (err) {
        if (!aLsErr) aLsErr = '';
        aLsErr += (aLsErr && '\n') + err.message;
      } else {
        for (var a in members)
          if (a !== that.uid)
            iReq.to[a] = 1;
      }
      if (iReq.to[list] === 3)
        iReq.to[that.uid] = 1;
      delete iReq.to[list];
      if (--aLsCount === 0)
        fPostCommon();
    }
    function fPostCommon() {
      for (var any in iReq.to) break;
      if (aPoCount === 0 || any || !iReq.noNodes) {
        ++aPoCount;
        that._postSend(iReq, iBuf, aLsErr, fAck);
      }
    }
    function fAck(err, toErr) {
      if (!aPoErr || !aPoErr.message)
        aPoErr = err || toErr && (aPoErr ? aPoErr+'\n' : '') + toErr;
      if (--aPoCount === 0)
        that._ack(iReq.id, aPoErr && aPoErr.message && aPoErr, aPoErr && aPoErr.message ? undefined : aPoErr);
    }
  };

  Link.prototype._postSend = function(iReq, iBuf, iAckErr, iCallback) {
    var that = this;
    for (var any in iReq.to) break;
    if (!any && iReq.noNodes)
      return iCallback({message:'msg lacks recipients'});
    var aId = this._makeId();
    var aMsg = packMsg({op:that.kQueueOp[iReq.op], id:aId, from:that.uid, etc:iReq.etc}, iBuf);
    storeFile(sTempDir+aId, aMsg, function(err) {
      if (err) return iCallback(err);
      sMsgCache.add(aId, aMsg);
      var aTo = {}, aToCount = 0;
      for (var aUid in iReq.to) {
        ++aToCount;
        addPending(aUid, aId);
        sRegSvc.getNodes(aUid, fUidCb);
      }
      if (!iReq.noNodes && !(that.uid in iReq.to)) {
        ++aToCount;
        addPending(that.uid, aId);
        sRegSvc.getNodes(that.uid, fUidCb);
      }
      function fUidCb(err, uid, list) {
        if (err) {
          console.log(err.message);
          if (!iAckErr) iAckErr = '';
          iAckErr += (iAckErr && '\n') + err.message;
        } else {
          for (var aN in list)
            if (uid in iReq.to || uid+','+aN !== that.node)
              aTo[uid+','+aN] = uid in iReq.to ? iReq.to[uid] : 1;
        }
        if (--aToCount > 0)
          return;
        for (var aN in aTo) {
          ++aToCount;
          queueItem(aN, aId, aTo[aN], fToCb);
        }
        if (aToCount === 0) {
          sMsgCache.unlink(aId);
          fToCb();
        }
        function fToCb() {
          if (--aToCount > 0)
            return;
          for (var aUid in iReq.to)
            delPending(aUid, aId);
          if (!iReq.noNodes && !(that.uid in iReq.to))
            delPending(that.uid, aId);
          fs.unlink(sTempDir+aId, noop);
          iCallback(null, iAckErr);
        }
      }
    });
  };

  Link.prototype.handle_ping = function(iReq, iBuf) {
    var that = this;
    sRegSvc.lookup(iReq.alias, function(err, node) {
      if (err)
        return that._ack(iReq.id, err);
      delete iReq.alias;
      iReq.to = {};
      iReq.to[node] = 1;
      that._postSend(iReq, iBuf, null, function(err, toErr) {
        that._ack(iReq.id, err, toErr);
      });
    });
  };

  Link.prototype.handle_ack = function(iReq) {
    if (iReq.type === 'ok')
      deQueueItem(this.node, iReq.id);
  };

  Link.prototype.finalize = function() {
    if (!this.conn) {
      console.log('finalize called on finalized Link');
      return;
    }
    if (this.node) {
      stopQueue(this.node);
      delete sActive[this.node];
    }
    if (this.loginTimer)
      clearTimeout(this.loginTimer);
    this.conn = null;
  };


