import{describe,test,expect}from"bun:test";
import{Election}from"../src/election";
import{TestClock}from"../src/clock";
import type{ClusterMessage,Member,Transport}from"../src/types";

class FakeTransport implements Transport{
  sent:ClusterMessage[]=[];
  async send(_to:string,message:ClusterMessage){this.sent.push(message)}
  async broadcast(_from:string,message:ClusterMessage){this.sent.push(message)}
}

const member=(id:string):Member=>({
  id,service:"test",cluster:"test",address:"http://"+id,version:"1",protocolVersion:"1",
  createdAt:0,status:"healthy",lifecycle:"active",incarnation:1,lastSeen:0
});

describe("election configuration liveness",()=>{
  test("accepts a heartbeat from the previous committed configuration during convergence",async()=>{
    const clock=new TestClock();
    const transport=new FakeTransport();
    let role="follower" as const;
    const election=new Election("a",transport,clock,100,1000,2000,{
      members:()=>[member("a"),member("b")],
      healthy:()=>2,
      voters:()=>["a","b"],
      configurationVersion:()=>2n,
      persist:async()=>{},
      onRole:async r=>{role=r},
      onTerm:async()=>{},
    });
    await election.observeTerm(4n);

    const heartbeat:ClusterMessage={
      id:"hb-old",kind:"heartbeat",from:"a",term:4n,configurationVersion:1n,sentAt:clock.now(),
      payload:{leaderId:"a",configurationVersion:1n},signature:""
    };

    await election.receive(heartbeat);
    expect(election.leaderId).toBe("a");
    expect(role).toBe("follower");
  });

  test("accepts a heartbeat from a future configuration while configuration convergence is in flight",async()=>{
    const clock=new TestClock();
    const transport=new FakeTransport();
    const election=new Election("a",transport,clock,100,1000,2000,{
      members:()=>[member("a"),member("b")],
      healthy:()=>2,
      voters:()=>["a","b"],
      configurationVersion:()=>2n,
      persist:async()=>{},
      onRole:async()=>{},
      onTerm:async()=>{},
    });
    await election.observeTerm(4n);

    const heartbeat:ClusterMessage={
      id:"hb-future",kind:"heartbeat",from:"a",term:4n,configurationVersion:3n,sentAt:clock.now(),
      payload:{leaderId:"a",configurationVersion:3n},signature:""
    };

    await election.receive(heartbeat);
    expect(election.leaderId).toBe("a");
  });
});
